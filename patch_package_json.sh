node -e "
const fs = require('fs');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
packageJson.scripts['tauri'] = 'tauri';
fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
"
