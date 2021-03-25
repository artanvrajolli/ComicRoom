const fs = require('fs');
const unzip = require('unzip-stream')
const stream= require('stream')
const unrar = require('@node_js/unrar');
const path = require('path');

function extractComics(filename,extension,pathOutput = ""){
  try{
    fs.mkdirSync(process.cwd()+'/public/uploads/'+pathOutput)
  }catch(err){}
    if(extension == "cbz"){
        // cbz -> zip -> image
        fs.createReadStream(filename).pipe(unzip.Extract({ 
          path: process.cwd()+'/public/uploads/'+pathOutput
         }));
        return 'unZIP mode'
    }else{
        // cbr -> rar -> image
        const src = path.join(filename);
        const dest = process.cwd()+'/public/uploads/'+pathOutput;
        const command = 'e';
        const switches = ['-o+', '-idcd'];
        (async () => { 
          await unrar.uncompress({
            src,
            dest,
            command,
            switches,
          });
        })().catch(console.error);

        return 'unRAR mode'
    }
}

module.exports = extractComics;
//console.log(extractComics("Marvel Masterworks - Marvel Two-In-One v04 (2019) (Digital) (Zone-Empire).cbr"))
