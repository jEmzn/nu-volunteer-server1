# TODO: ย้ายจาก quick tunnel ไปใช้ domain ของตัวเอง (named tunnel)

ที่มา: load test วันที่ 7 พ.ย. 2569 (ดู `docs/WORKLOG.md`) พบปัญหาสองข้อที่แก้ได้ด้วยแผนนี้

1. quick tunnel (`*.trycloudflare.com`) รับ request ค้างพร้อมกันได้ไม่เกิน 200 ตัว เกินกว่านั้น Cloudflare ตอบ 429 ตัวเลขนี้เอกสารของ Cloudflare ระบุไว้เอง
2. หน้าเว็บเสิร์ฟจาก Vite dev ต้องโหลด 74 ไฟล์ รวม 27 MB ต่อการเปิดหน้าเว็บหนึ่งครั้ง พอเปิดพร้อมกันราว 20 เครื่องก็ชนเพดานข้อ 1 แล้ว

ในเอกสารนี้ `<domain>` คือ domain ของคุณ เว็บจะอยู่ที่ `app.<domain>` และ API จะอยู่ที่ `api.<domain>` เปลี่ยนชื่อได้ แต่ต้องใช้ชื่อเดียวกันทุกขั้น

## ทำไมตัวเลขในผลทดสอบถึงต่างกัน (อ่านก่อน)

| ตัวเลข | คืออะไร | วัดเป็น |
| --- | --- | --- |
| 200 | ช่องรับ request ของ quick tunnel | request ที่ค้างอยู่ ณ ขณะเดียวกัน รวมของทุกคน |
| 60 | ความเร็วที่ server เขียน claim ได้ | claim ที่เสร็จต่อวินาที |
| 20 เครื่อง | จำนวนมือถือที่เปิดหน้าเว็บพร้อมกันได้ก่อนพัง | มาจากเพดาน 200 เพราะแต่ละเครื่องเปิดไฟล์พร้อมกันราว 20 ไฟล์ |

เปรียบเทียบได้ว่า tunnel เป็นประตูที่ให้คนยืนรออยู่ข้างในได้ 200 คน ส่วน server เป็นแคชเชียร์ที่คิดเงินได้ 60 คนต่อวินาที

- **claim 200 พร้อมกันผ่าน แต่ 300 ไม่ผ่าน** เพราะ 200 ยังอยู่ในประตูพอดี ส่วน 300 เกินไป 100 คน คนที่เกินถูกตอบ 429 ทันที คนที่ผ่านเข้าไปก็ยังต้องรอคิวแคชเชียร์ 60 คนต่อวินาที เลยช้าเป็นวินาทีแต่ไม่พัง
- **หน้าเว็บพังตั้งแต่ 20 เครื่อง** เพราะมือถือหนึ่งเครื่องไม่ได้ส่งแค่ 1 request แต่โหลดไฟล์พร้อมกันราว 20 ไฟล์ 10 เครื่องคูณ 20 เท่ากับ 200 ยังพอดีประตู แต่ 20 เครื่องคูณ 20 เท่ากับ 400 เกินแล้ว เป็นเพดานเดียวกันกับข้อแรก แค่หน้าเว็บกินช่องมากกว่า claim ราว 20 เท่า
- **ทดสอบแบบทยอย 600 คนใน 10 วินาทีถึงผ่าน** เพราะเข้ามาแค่ 60 คนต่อวินาที และแต่ละคนเสร็จใน 0.1 วินาที จึงค้างพร้อมกันแค่ราว 6 ตัว ห่างจาก 200 มาก
- สูตรที่ใช้: request ค้างพร้อมกัน = จำนวนที่เข้ามาต่อวินาที × เวลาที่แต่ละ request ใช้

## ค่าใช้จ่าย

- Cloudflare แผน Free (DNS, Tunnel, Pages): ไม่มีค่าใช้จ่าย ที่ต้องจ่ายมีแค่ค่า domain ซึ่งจ่ายให้ผู้ให้บริการ domain ตามเดิม
- Pages แผน Free: build ได้ 500 ครั้งต่อเดือน (นับทั้งบัญชี), 20,000 ไฟล์ต่อเว็บ, ไฟล์ละไม่เกิน 25 MiB หน้าข้อจำกัดของ Pages ไม่ได้ระบุเพดานหรือค่าใช้จ่ายของ bandwidth และ request ไปยังไฟล์ static แต่ควรเปิดหน้า pricing ของ Cloudflare ดูอีกครั้งก่อนใช้จริง ที่มา: https://developers.cloudflare.com/pages/platform/limits/
- โปรเจกต์นี้ไม่ได้ใช้ Pages Functions จึงไม่ติดโควตาของ Workers

## ขั้นที่ 1: ย้าย DNS ของ domain มาที่ Cloudflare

ทำครั้งเดียว และต้องทำก่อนขั้นอื่น

- [ ] สมัครหรือเข้าบัญชี https://dash.cloudflare.com
- [ ] กด "Add a domain" ใส่ `<domain>` แล้วเลือกแผน Free
- [ ] ตรวจรายการ DNS ที่ Cloudflare ดึงมาให้ ต้องครบเท่าของเดิม โดยเฉพาะ MX ถ้า domain นี้ใช้รับอีเมล ถ้าขาดอีเมลจะหาย
- [ ] จด nameserver สองตัวที่ Cloudflare ให้มา (รูปแบบ `xxx.ns.cloudflare.com`)
- [ ] เข้าหน้าจัดการ domain ที่ผู้ให้บริการ domain เปลี่ยน nameserver เป็นสองตัวนั้น และลบ nameserver เดิมออก
- [ ] ถ้าผู้ให้บริการ domain เปิด DNSSEC ไว้ ให้ปิดก่อนเปลี่ยน nameserver แล้วค่อยเปิดใหม่ใน Cloudflare ภายหลัง ไม่อย่างนั้น domain อาจใช้ไม่ได้ระหว่างย้าย
- [ ] รอจนหน้า Overview ของ domain ใน Cloudflare ขึ้นสถานะ **Active** อาจใช้เวลาไม่กี่นาทีไปจนถึง 24 ชั่วโมง
- [ ] ตรวจ: `dig NS <domain> +short` ต้องเห็น nameserver ของ Cloudflare

## ขั้นที่ 2: สร้าง named tunnel สำหรับ API

ทำบนเครื่อง server

- [ ] `cloudflared --version` ถ้าเก่ากว่าปีปัจจุบันให้อัปเดตก่อน
- [ ] `cloudflared tunnel login` จะเปิด browser ให้เลือก `<domain>` แล้วสร้างไฟล์ `~/.cloudflared/cert.pem`
- [ ] `cloudflared tunnel create nuvol` จะได้ UUID ของ tunnel และไฟล์ `~/.cloudflared/<UUID>.json` **ไฟล์นี้เป็นกุญแจของ tunnel ห้าม commit และห้ามส่งให้ใคร**
- [ ] `cloudflared tunnel route dns nuvol api.<domain>` จะสร้าง CNAME ของ `api.<domain>` ชี้ไปที่ tunnel ให้เอง
- [ ] สร้าง `~/.cloudflared/config.yml`
  ```yaml
  tunnel: <UUID>
  credentials-file: /home/<user>/.cloudflared/<UUID>.json
  ingress:
    - hostname: api.<domain>
      service: http://localhost:3000
    - service: http_status:404
  ```
  ถ้าใช้ทางเลือก B ในขั้นที่ 3 ให้เปลี่ยนตามที่เขียนไว้ในขั้นนั้น
- [ ] ลองรันด้วยมือก่อน: `cloudflared tunnel run nuvol`
- [ ] ตรวจจากเครื่องอื่นหรือจากมือถือที่ใช้ 4G: `curl https://api.<domain>/health` ต้องได้ `{"status":"ok","db":"ok"}`

## ขั้นที่ 3: เลิกเสิร์ฟหน้าเว็บจาก Vite dev

เลือกทางใดทางหนึ่ง **แนะนำทางเลือก A** เพราะหน้าเว็บจะไม่ผ่านเครื่อง server และ tunnel เลย ทั้งเพดานและเน็ต upload ของเครื่อง server ใช้กับ API อย่างเดียว

### ทางเลือก A: Cloudflare Pages (แนะนำ)

- [ ] build หน้าเว็บโดยให้ชี้ไปที่ API ตัวจริง ทำใน `nu-volunteer-web`
  ```bash
  VITE_API_URL=https://api.<domain> npm run build      # ได้โฟลเดอร์ dist/
  ```
  `VITE_API_URL` ต้องเป็น URL เต็ม และต้องไม่มี path ต่อท้าย เพราะ socket.io-client จะอ่าน path เป็นชื่อ namespace (ดู WORKLOG วันที่ 6 พ.ย.)
- [ ] อัปโหลดขึ้น Pages ครั้งแรกจะถามให้ login และสร้างโปรเจกต์
  ```bash
  npx wrangler pages deploy dist --project-name nuvol-web
  ```
  อีกวิธีคือผูก Pages กับ Git repo ใน dashboard ถ้าใช้วิธีนี้ต้องตั้ง `VITE_API_URL` ใน Settings > Environment variables ของโปรเจกต์ Pages ด้วย
- [ ] ใน dashboard ไปที่ Workers & Pages > `nuvol-web` > Custom domains > เพิ่ม `app.<domain>`
- [ ] เว็บใช้ `HashRouter` จึงไม่ต้องตั้ง rewrite ของ SPA
- [ ] ใส่ CSP ด้วย `public/_headers` ตาม "แผน CSP" ใน `docs/WORKLOG.md` หัวข้อ 7 พ.ย. 2569 ตรวจความปลอดภัย
- [ ] Pages cache ไฟล์ที่ชื่อมี hash ไว้ที่ edge ให้เอง ไม่ต้องตั้ง `Cache-Control`
- [ ] ตรวจ: เปิด `https://app.<domain>` บนมือถือ แล้วดูใน DevTools > Network ว่าโหลดไม่กี่ไฟล์และรวมแล้วไม่เกินราว 1 MB ไม่ใช่ 74 ไฟล์ 27 MB

### ทางเลือก B: Nginx บนเครื่อง server

ใช้ tunnel ตัวเดียว ให้ทั้ง `app.<domain>` ชี้เข้า Nginx ที่ port 8080 Nginx เสิร์ฟ `dist/` และส่ง path ของ API ต่อไปที่ 3000 ทางนี้ไม่ต้องตั้ง CORS แต่หน้าเว็บจะกินเน็ต upload ของเครื่อง server ตอนเปิดหน้าครั้งแรก

- [ ] `VITE_API_URL=https://app.<domain> npm run build` แล้ว copy `dist/` ไปไว้ที่ `/srv/nuvol-web`
- [ ] ตั้ง Nginx ให้ใช้รายการ path ของ API ชุดเดียวกับ proxy ใน `nu-volunteer-web/vite.config.ts` และใส่ cache header ให้ไฟล์ที่มี hash
  ```nginx
  server {
    listen 127.0.0.1:8080;
    root /srv/nuvol-web;
    location ~ ^/(auth|activities|students|claims|templates|stats|health|time)(/|$) {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location /socket.io/ {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    location / { try_files $uri /index.html; }
  }
  ```
- [ ] ใน `config.yml` ของขั้นที่ 2 เปลี่ยน hostname เป็น `app.<domain>` และ service เป็น `http://localhost:8080` แล้วรัน `cloudflared tunnel route dns nuvol app.<domain>`
- [ ] ตั้ง `TRUST_PROXY=2` ใน `.env` ของ server เพราะ request ผ่าน proxy สองชั้นคือ cloudflared แล้วตามด้วย Nginx
- [ ] ถ้าเพิ่ม controller ที่ path ขึ้นต้นใหม่ ต้องเพิ่มชื่อใน Nginx ด้วย เหมือนที่ต้องทำกับ Vite

## ขั้นที่ 4: ตั้งค่า server ให้ตรงกับ URL ใหม่

แก้ `.env` ของ server แล้ว restart เพราะ server อ่าน `.env` ตอน start เท่านั้น

| ตัวแปร | ทางเลือก A | ทางเลือก B |
| --- | --- | --- |
| `WEB_ORIGIN` (ลิงก์ใน QR) | `https://app.<domain>` | `https://app.<domain>` |
| `CORS_ORIGINS` | `https://app.<domain>` | ไม่ต้องตั้ง (โดเมนเดียวกัน) |
| `TRUST_PROXY` | `1` | `2` |

- [ ] แก้ `.env` แล้ว `npm run build && npm start`
- [ ] ตรวจ: สร้างกิจกรรมทดสอบ เปิด QR แล้วสแกนด้วยมือถือที่ใช้ 4G ต้องได้ชั่วโมง และหน้าผู้ดูแลต้องเห็นรายชื่อขึ้นแบบ realtime ซึ่งเป็นการยืนยันว่า WebSocket ผ่าน tunnel ได้
- [ ] ตรวจ rate limit ว่าแยกตาม IP จริง: ดู log ของ server ตอนสองเครื่องจากเน็ตต่างกัน login ต้องไม่เห็น IP เป็น `127.0.0.1` หรือเป็น IP เดียวกัน

## ขั้นที่ 5: ให้ทุกอย่างรันเองเมื่อเครื่องรีสตาร์ท

- [ ] ติดตั้ง cloudflared เป็น service
  ```bash
  sudo mkdir -p /etc/cloudflared
  sudo cp ~/.cloudflared/config.yml ~/.cloudflared/<UUID>.json /etc/cloudflared/
  # แก้ credentials-file ใน /etc/cloudflared/config.yml เป็น /etc/cloudflared/<UUID>.json
  sudo cloudflared service install
  sudo systemctl enable --now cloudflared
  ```
- [ ] สร้าง systemd unit ให้ API (`node dist/main.js` ใน working directory ของ server) โดยตั้ง `Restart=always`
- [ ] ถ้าใช้ทางเลือก B: `sudo systemctl enable --now nginx`
- [ ] วันจริงต้องใช้ PostgreSQL ตัวจริงที่มี backup ไม่ใช่ `npm run db:dev`
- [ ] ตรวจ: reboot เครื่องแล้ว `curl https://api.<domain>/health` ต้องตอบได้เองโดยไม่ต้องสั่งอะไร

## ขั้นที่ 6: ตรวจการตั้งค่าความปลอดภัยของ Cloudflare ที่อาจบล็อกนิสิต

นิสิตหลายร้อยคนใช้ Wi-Fi เดียวกัน จึงออกเน็ตด้วย IP เดียวกัน Cloudflare อาจมองว่าเป็น bot

- [ ] Security > Bots: ปิด Bot Fight Mode หรือยกเว้น `api.<domain>` เพราะ API ถูกเรียกด้วย `fetch` ซึ่งตอบ challenge ไม่ได้ request จะพังเงียบ ๆ
- [ ] Security > Settings: Security Level ไม่ควรตั้งเป็น "I'm Under Attack"
- [ ] ไม่ต้องสร้าง rate limiting rule ของ Cloudflare เพิ่ม เพราะ server จำกัดเองแล้ว (`RATE_*`)

## ขั้นที่ 7: ทดสอบซ้ำบน domain จริง

ใช้สคริปต์เดิม ตั้ง `BASE_URL=https://api.<domain>` (ทางเลือก A) หรือ `https://app.<domain>` (ทางเลือก B) และ **ไล่โหลดขึ้นทีละขั้น อย่าเริ่มที่โหลดสูงสุด** การยิงแรงเกินไปอาจทำให้ Cloudflare ตั้ง challenge หรือบล็อก IP ของคุณบน domain จริง

- [ ] ข้อ 1–2 ของ `docs/LOAD-TEST-TODO.md` ด้วย `load/claims.k6.js` ต้องผ่านเหมือนเดิม
- [ ] claim แบบ burst ไล่ `CONC` = 100, 200, 300, 400 ผลที่คาดคือไม่มี 429 จาก Cloudflare ที่ 300 ขึ้นไป แต่ยังช้าตามคิว 60 claim ต่อวินาที ถ้ายังเจอ 429 ให้ดู header `server` ของ response ว่ามาจาก Cloudflare หรือจาก server
- [ ] เปิดหน้าเว็บพร้อมกัน 20, 60, 200 เครื่อง ทางเลือก A คาดว่าไม่พังเลย
- [ ] สคริปต์ burst และสคริปต์เปิดหน้าเว็บยังไม่อยู่ใน repo ต้องย้ายจาก scratchpad มาไว้ที่ `load/` ก่อน
- [ ] จดผลลง WORKLOG

## ข้อแนะนำ: เพิ่มความเร็ว server ให้เกิน 60 claim ต่อวินาที (ยังไม่ตัดสินใจ)

แผนนี้ไม่แก้เพดาน 60 claim ต่อวินาที เพราะเพดานนี้อยู่ที่ server ไม่ได้อยู่ที่ tunnel ถ้าคนกดพร้อมกันเป็นร้อย จะรอเป็นวินาทีแต่ไม่พัง และเกณฑ์ p95 < 500 ms ผ่านเฉพาะตอนคนทยอยสแกน

ต้องวัดก่อนแก้: ใส่เวลาของแต่ละ query ใน transaction ของ claim (`claims/claims.ts` และ `claims/credit-writer.ts`) แล้วยิง burst ตรงเข้า server ดูว่าเวลาราว 16 ms ต่อ claim หมดไปตรงไหน สาเหตุที่น่าสงสัยที่สุดคือ claim ทุกตัวต่อคิว `lockActivity()` ของกิจกรรมเดียวกัน แต่ยังไม่ได้ยืนยัน

ทางเลือก เรียงจากแก้น้อยไปมาก:

| ทางเลือก | ทำอะไร | ข้อดี | ข้อเสีย |
| --- | --- | --- | --- |
| 1. ไม่แก้โค้ด จัดคิวหน้างาน | ให้สแกนเป็นรอบ ทีละแถวหรือทีละกลุ่ม (`LOAD-TEST-TODO.md` ข้อ 6) | ไม่เสี่ยงอะไรเลย | ต้องมีคนคุมหน้างาน |
| 2. ลดงานที่ทำระหว่างถือ lock | ย้ายงานที่ไม่ต้องอยู่ใต้ lock เช่นตรวจ token หรือหา student ออกไปทำก่อน `lockActivity()` และรวม query ที่ทำต่อกันให้เหลือน้อยรอบ | ได้ผลตรงจุดถ้า profile ชี้ว่าเป็น lock | ต้องระวังกฎที่ต้องเห็นข้อมูลล่าสุด และต้องรัน test ของ claims ให้ผ่านทั้งหมด |
| 3. ไม่ถือ lock แถวกิจกรรมสำหรับ QR claim | ใช้ unique constraint ของ `credits (activity_id, student_id)` ที่มีอยู่แล้วกันข้อมูลซ้ำ และอัปเดตตัวนับด้วย `UPDATE ... SET credit_count = credit_count + 1` แบบ atomic | ทำงานพร้อมกันได้จริง ความเร็วขึ้นกับ pool และ CPU | ขัดกับหลักใน CLAUDE.md ที่ให้กฎที่ห้ามสลับกันทำใต้ `lockActivity()` เพดานผู้เข้าร่วมและการตรวจเครื่องซ้ำต้องออกแบบใหม่ เสี่ยงที่สุด |
| 4. เพิ่ม `DB_POOL_MAX` | ปรับใน `.env` | ง่าย | ถ้าคอขวดคือ lock จะไม่ช่วย เพราะทุก claim ยังต่อคิวเดียวกัน ควรลองหลัง profile เท่านั้น |

คำแนะนำ: วันจริงใช้ทางเลือกที่ 1 ไปก่อน แล้ว profile ถ้าตัวเลขชี้ว่าเป็น lock ค่อยพิจารณาทางเลือกที่ 2 ส่วนทางเลือกที่ 3 ใช้เมื่อจำเป็นจริงเท่านั้น

## ข้อแนะนำ: ฝั่ง web client (แก้ไม่มาก ไม่เกี่ยวกับ cloudflared)

- [ ] แยกข้อความกรณี 429 ออกจากกรณีไม่มีอินเทอร์เน็ต (`nu-volunteer-web/src/data/remote.ts` `claim()` และ `Waiting.tsx`) เช่น "ระบบมีคนใช้งานมาก บันทึกการสแกนไว้แล้ว จะส่งให้อัตโนมัติ ไม่ต้องสแกนซ้ำ"
- [ ] สุ่มเวลารอก่อนส่งซ้ำใน `src/lib/pending.ts` (`BACKOFF_MS`) ไม่อย่างนั้นมือถือที่โดน 429 พร้อมกันจะส่งซ้ำพร้อมกันอีกรอบ
- [ ] แจ้งผู้ดูแลว่า credit ที่มี flag `offline` อาจมาจากระบบแน่นได้ ไม่ใช่แค่เน็ตของนิสิตหลุด
