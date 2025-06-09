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

async function extractComics(filename,extension,pathOutput = ""){
  try{
    fs.mkdirSync(process.cwd()+'/public/uploads/'+pathOutput)
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
            for (const file of files) {
              if (!file.extraction) continue;
              
              const filePath = path.join(dest, file.fileHeader.name);
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
//console.log(extractComics("Marvel Masterworks - Marvel Two-In-One v04 (2019) (Digital) (Zone-Empire).cbr"))
