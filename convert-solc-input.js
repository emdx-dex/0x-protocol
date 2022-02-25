const fs = require("fs");

let rawdata = fs.readFileSync('./contracts/exchange/generated-artifacts/Exchange.json');
let oldJSON = JSON.parse(rawdata);
let newJSON = { 
    "language": "Solidity",
}

newJSON["sources"]= oldJSON.sources
newJSON["settings"] =oldJSON.compiler.settings
newJSON["settings"]["remappings"] = ["../src=src",
                                     "./=",]

//delete id property from oldJSON.sources
for (let key in newJSON.sources) {
    //IF KEY STARTS WITH ./
    /* if (key.startsWith("./")) {
      //remove ./
      let newKey = key.substring(2);
      newJSON.sources[newKey] = newJSON.sources[key];
      delete newJSON.sources[newKey].id
      delete newJSON.sources[key];
    } else{
      delete newJSON.sources[key].id
    }  */   
    delete newJSON.sources[key].id
}

console.log(newJSON);
storeData(newJSON, './standard-solc-input.json');


function storeData(data, path){
    try {
      fs.writeFileSync(path, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(err)
    }
  } 