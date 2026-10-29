# MyDroidGrid

Apna cloud Android phone system — apne **apne Oracle Cloud** account par, one-click setup ke sath. Koi coding nahi chahiye: sirf server ki bunyadi details deni hain, install aur setting sab khud ho jata hai.

## Shuru kaise karein (non-coders ke liye)

Poori step-by-step guide is file me hai: **SETUP-GUIDE.txt**

Teen raaste hain:

1. **Copy-paste (sab se asaan):** Oracle par machine banate waqt `cloud-init-userdata.txt` ka poora text "User data" box me paste kar do — machine chalte hi sab install ho jayega.
2. **Ek command:** Apne computer se `bash deploy.sh` chalao — script sirf server ka IP, username aur key file puchega.
3. **Server par direct:** `bash install-on-server.sh` — sirf 2 sawal (kitne phones, port), baqi sab auto. Server ki RAM/cores khud parh kar config lag jati hai.

## Files

- `app/` — MyDroidGrid website/dashboard (Node.js, koi npm install nahi chahiye)
- `install-on-server.sh` — Ubuntu server par one-click installer (Node, Docker, kernel modules, service, firewall — sab auto)
- `deploy.sh` — apne computer se server par bhej kar install karne wala script
- `configure.js` — server ki asal RAM/cores ke hisaab se config khud set karta hai
- `cloud-init-userdata.txt` — Oracle machine banate waqt paste karne wala text (download link pehle se set hai)
- `SETUP-GUIDE.txt` — asaan zaban me poori guide

## Ek se zyada server? (2, 3, jitne chaaho)

Har server par yehi setup lagega. Phir kisi ek server ke dashboard me **Add Server** dabakar doosre servers ka **IP + port** add kar do — sab servers ki online/offline halat ek hi jagah dikhegi aur har ek ka dashboard ek click par khul jayega. Yaad rahe: har server apna alag system hai, un ki taaqat (RAM/cores) jama nahi hoti.

## Zaruri baat

Har banda apna Oracle account use karega. Setup ke baad Oracle Console me apni machine ke Security List me **TCP port 4000** kholna lazmi hai, warna website bahar se nahi khulegi (guide me Step 4).

**Halat (status):** Ye website/dashboard + server ki poori tayyari install karta hai. Asal phone engine (Redroid) ko dashboard se jorna agle phase ka kaam hai — installer us ke kernel modules load karne ki koshish karta hai aur na milein to saaf warning deta hai.
