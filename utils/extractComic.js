const fs = require('fs');
const unzip = require('unzip-stream')
const { createExtractorFromFile } = require('node-unrar-js');
const path = require('path');

async function extractComics(filename,extension,pathOutput = ""){
  try{
    fs.mkdirSync(process.cwd()+'/public/uploads/'+pathOutput)
  }catch(err){}
    if(extension == "cbz"){
         return new Promise((resolve, reject) => {
          const file = fs.createReadStream(filename).pipe(unzip.Extract({ 
            path: process.cwd()+'/public/uploads/'+pathOutput
           }));
          file.on("finish", () => { resolve(true); }); 
          file.on("error", reject);
        });    }else{
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
