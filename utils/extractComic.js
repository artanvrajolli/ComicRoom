const fs = require('fs');
const unzip = require('unzip-stream')
const unrar = require('@node_js/unrar');
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
        });
    }else{
        // cbr -> rar -> image
        return new Promise((resolve, reject) => {
        const src = filename;
        const dest = process.cwd()+'/public/uploads/'+pathOutput;
        const command = 'e';
        const switches = ['-o+', '-idcd'];

        (async () => {
          unrar.on('progress', percent => {
            if(percent == "100%"){
              resolve(true);
            }
          });
         
          await unrar.uncompress({
            src,
            dest,
            command,
            switches,
          });
        })().catch(console.error);

        return 'unRAR mode'
      });
    }
}

module.exports = extractComics;
//console.log(extractComics("Marvel Masterworks - Marvel Two-In-One v04 (2019) (Digital) (Zone-Empire).cbr"))
