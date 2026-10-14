const fs = require('fs');
const file = 'src-tauri/tauri.conf.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

// We need to disable CSP for local API fetches since they might fetch from custom RPCs,
// or we can just open it up for development.
if (!data.app.security) {
  data.app.security = {};
}
data.app.security.csp = "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: http: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval';";

// Build it into an MSI / EXE for Windows by targeting windows
if (!data.bundle.targets) {
  data.bundle.targets = ["nsis"];
}

fs.writeFileSync(file, JSON.stringify(data, null, 2));
