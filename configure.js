// MyDroidGrid — automatic server configuration
// Ye script server ki asal taaqat (RAM / cores) khud parhti hai aur config.json
// ko usi hisaab se set karti hai. User ko kuch type nahi karna parta.
// Values env se bhi di ja sakti hain: MDG_SITE_NAME, MDG_PORT, MDG_MAX_PHONES,
// MDG_STORAGE_POOL_GB, MDG_HOST_RAM_GB, MDG_HOST_CORES, MDG_PHONE_DATA_DIR
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDir = process.argv[2] || __dirname;
const cfgPath = path.join(appDir, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback; }

const ramGB = num(process.env.MDG_HOST_RAM_GB, Math.floor(os.totalmem() / (1024 ** 3)));
const cores = num(process.env.MDG_HOST_CORES, os.cpus().length);
const reservedRamGB = ramGB >= 20 ? 4 : ramGB >= 8 ? 2 : 1;
const reservedCores = cores >= 4 ? 1 : 0;

cfg.siteName = String(process.env.MDG_SITE_NAME || cfg.siteName || 'MyDroidGrid').slice(0, 40);
cfg.port = num(process.env.MDG_PORT, cfg.port || 4000);
cfg.maxPhones = num(process.env.MDG_MAX_PHONES, cfg.maxPhones || 4);
cfg.host = {
  label: 'Cloud Server',
  ramGB,
  cores,
  reservedRamGB,
  reservedCores,
  storageGB: num(process.env.MDG_STORAGE_POOL_GB, cfg.host?.storageGB || 150)
};
cfg.phoneDataPartitionGB = cfg.host.storageGB;
if (process.env.MDG_PHONE_DATA_DIR) cfg.phoneDataDir = process.env.MDG_PHONE_DATA_DIR;

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`Config tayyar: ${ramGB} GB RAM, ${cores} cores (system ke liye ${reservedRamGB} GB / ${reservedCores} core reserved), max ${cfg.maxPhones} phones, storage pool ${cfg.host.storageGB} GB, port ${cfg.port}`);
