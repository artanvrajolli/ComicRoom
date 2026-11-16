const fs = require('fs');
const AdmZip = require('adm-zip');
const { createExtractorFromFile } = require('node-unrar-js');
const path = require('path');

// Function to check if file has valid ZIP signature
function isValidZipFile(filename) {
  try {
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(filename, 'r');
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    
    // Check for ZIP file signatures
    // PK\x03\x04 (local file header)
    // PK\x05\x06 (end of central directory)
    // PK\x07\x08 (data descriptor)
    const signature = buffer.toString('hex');
    return signature.startsWith('504b0304') || // PK\x03\x04
           signature.startsWith('504b0506') || // PK\x05\x06  
           signature.startsWith('504b0708');   // PK\x07\x08
  } catch (error) {
    console.error('Error checking file signature:', error);
    return false;
  }
}

const ZIP_EXTENSIONS = ['cbz', 'zip'];
const RAR_EXTENSIONS = ['cbr', 'rar'];

// Reads the first bytes to tell what the file really is. Comic files are often
// misnamed (a .cbr that is a zip, a .zip that is a rar), so the content wins
// over the extension. Returns 'zip', 'rar', 'pdf', '7z' or ''.
function sniffArchiveKind(filename) {
  let fd = null;
  try {
    const buffer = Buffer.alloc(8);
    fd = fs.openSync(filename, 'r');
    const read = fs.readSync(fd, buffer, 0, 8, 0);
    const head = buffer.subarray(0, read);
    const hex = head.toString('hex');
    if (hex.startsWith('504b0304') || hex.startsWith('504b0506') || hex.startsWith('504b0708')) return 'zip';
    if (hex.startsWith('526172211a07')) return 'rar'; // "Rar!\x1a\x07" (RAR 4 and 5)
    if (head.toString('latin1').startsWith('%PDF')) return 'pdf';
    if (hex.startsWith('377abcaf271c')) return '7z';
  } catch (error) {
    // unreadable: fall back to the extension
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
  return '';
}

// 'zip' | 'rar' | 'pdf' for a file, by content first and extension second.
function resolveArchiveKind(filename, extension) {
  const sniffed = sniffArchiveKind(filename);
  if (sniffed === '7z') {
    throw new Error('7-Zip archives (.7z / .cb7) are not supported. Repack the comic as .zip, .cbz, .rar or .cbr.');
  }
  if (sniffed) return sniffed;
  const ext = String(extension || '').replace(/^\./, '').toLowerCase();
  if (ZIP_EXTENSIONS.includes(ext)) return 'zip';
  if (RAR_EXTENSIONS.includes(ext)) return 'rar';
  if (ext === 'pdf') return 'pdf';
  return '';
}

async function extractComics(filename,extension,pathOutput = ""){
    const kind = resolveArchiveKind(filename, extension);
    if (!kind) {
        throw new Error('This file is not a comic archive this app can open (expected ZIP, RAR or PDF content).');
    }
    extension = kind === 'zip' ? 'cbz' : kind === 'rar' ? 'cbr' : 'pdf';
  try{
    fs.mkdirSync(process.cwd()+'/public/uploads/'+pathOutput, { recursive: true })
  }catch(err){}
    if(extension == "cbz"){
        return new Promise((resolve, reject) => {
          console.log(`Extracting CBZ file: ${filename}`);
          
          try {
            // First, check if the file exists and is readable
            if (!fs.existsSync(filename)) {
              return reject(new Error(`File does not exist: ${filename}`));
            }
            
            // Check file size
            const stats = fs.statSync(filename);
            if (stats.size === 0) {
              return reject(new Error('File is empty'));
            }
            
            console.log(`File size: ${stats.size} bytes`);
            
            // Validate ZIP file signature
            if (!isValidZipFile(filename)) {
              return reject(new Error('File does not appear to be a valid ZIP file. Please ensure your .cbz file is properly formatted.'));
            }
            
            // Create AdmZip instance
            const zip = new AdmZip(filename);
            const outputPath = process.cwd()+'/public/uploads/'+pathOutput;
            
            // Get all entries to validate the zip file
            const entries = zip.getEntries();
            
            if (entries.length === 0) {
              return reject(new Error('ZIP file appears to be empty or corrupted'));
            }
            
            console.log(`Found ${entries.length} entries in ZIP file`);
            
            // Extract all files
            zip.extractAllTo(outputPath, /*overwrite*/true);
            
            console.log('CBZ extraction completed successfully');
            resolve(true);
            
          } catch (error) {
            console.error('CBZ extraction error:', error);
            
            // Provide more specific error messages
            if (error.message.includes('Invalid or unsupported zip format') || 
                error.message.includes('Invalid CEN header') ||
                error.message.includes('bad signature')) {
              reject(new Error('Invalid or corrupted ZIP file. Please ensure the .cbz file is a valid ZIP archive.'));
            } else if (error.message.includes('ENOENT')) {
              reject(new Error('File not found or cannot be accessed.'));
            } else if (error.message.includes('EACCES')) {
              reject(new Error('Permission denied accessing the file.'));
            } else {
              reject(new Error(`ZIP extraction failed: ${error.message}`));
            }
          }
        });
    }else if(extension == "pdf"){
        return new Promise(async (resolve, reject) => {
          try {
            const outputPath = process.cwd()+'/public/uploads/'+pathOutput;
            const { pdfToImg } = await import('pdftoimg-js');
            const convertedImages = await pdfToImg(filename, {
              pages: 'all',
              imgType: 'png',
              scale: 2,
              background: 'white'
            });

            const imagePages = Array.isArray(convertedImages) ? convertedImages : [convertedImages];

            if (imagePages.length === 0) {
              reject(new Error('PDF conversion did not produce any image pages.'));
              return;
            }

            imagePages.forEach((imagePage, index) => {
              const pageData = typeof imagePage === 'string'
                ? imagePage
                : imagePage && typeof imagePage.dataUrl === 'string'
                  ? imagePage.dataUrl
                  : imagePage && typeof imagePage.src === 'string'
                    ? imagePage.src
                    : imagePage && typeof imagePage.base64 === 'string'
                      ? imagePage.base64
                      : '';

              if (!pageData) {
                throw new Error(`PDF page ${index + 1} did not return image data.`);
              }

              const base64Content = pageData.includes(',') ? pageData.split(',')[1] : pageData;
              const imageBuffer = Buffer.from(base64Content, 'base64');
              const outputFileName = `page_${String(index + 1).padStart(4, '0')}.png`;
              fs.writeFileSync(path.join(outputPath, outputFileName), imageBuffer);
            });

            resolve(true);
          } catch (error) {
            console.error('Error converting PDF file:', error);
            reject(new Error(`PDF conversion failed: ${error.message}`));
          }
        });
    }else{
        // cbr -> rar -> image
        return new Promise(async (resolve, reject) => {
          try {
            const src = filename;
            const dest = process.cwd()+'/public/uploads/'+pathOutput;
            
            // Create extractor from the RAR file
            const extractor = await createExtractorFromFile({
              filepath: src,
              targetPath: dest
            });
            
            // Extract all files
            const extracted = extractor.extract();
            const files = [...extracted.files];
            
            // Save all extracted files
            const destRoot = path.resolve(dest) + path.sep;
            for (const file of files) {
              if (!file.extraction) continue;
              
              const filePath = path.resolve(dest, file.fileHeader.name);
              // Never write outside the comic folder ("../" entries in a hostile archive).
              if (!filePath.startsWith(destRoot)) {
                console.warn('Skipping RAR entry outside the target folder: ' + file.fileHeader.name);
                continue;
              }
              const dir = path.dirname(filePath);
              
              // Create directory if it doesn't exist
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              
              // Write file content
              fs.writeFileSync(filePath, file.extraction);
            }
            
            resolve(true);
          } catch (error) {
            console.error('Error extracting RAR file:', error);
            reject(error);
          }
        });
    }
}

module.exports = extractComics;
module.exports.resolveArchiveKind = resolveArchiveKind;
module.exports.sniffArchiveKind = sniffArchiveKind;
//console.log(extractComics("Marvel Masterworks - Marvel Two-In-One v04 (2019) (Digital) (Zone-Empire).cbr"))
