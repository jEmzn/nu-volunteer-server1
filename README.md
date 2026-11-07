# NU Volunteer Backend

Backend ของเว็บเก็บชั่วโมงจิตอาสา มหาวิทยาลัยนเรศวร (NestJS + PostgreSQL) ใช้แทน Supabase

| เอกสาร | เนื้อหา |
| --- | --- |
| [docs/API-CONTRACT.md](docs/API-CONTRACT.md) | สัญญา API สำหรับคนเขียน `remote.ts` |
| [docs/WORKLOG.md](docs/WORKLOG.md) | บันทึกการทำงาน การตัดสินใจ และผลเทสต์ |
| `/api/docs` | เอกสาร OpenAPI ขณะ server ทำงาน เปิดเมื่อตั้ง `API_DOCS=1` เท่านั้น |

## เริ่มใช้งานบนเครื่องพัฒนา

ต้องมี Node.js 22 ขึ้นไป ไม่ต้องติดตั้ง PostgreSQL หรือ Docker

```bash
npm install
npm run db:dev          # เทอร์มินัลที่ 1: เปิด PostgreSQL 16 ในเครื่อง ข้อมูลอยู่ใน .dev-db/
cp .env.example .env    # แล้วแก้ DATABASE_URL ตามที่ db:dev พิมพ์ออกมา และใส่ JWT_SECRET, QR_SECRET
npm run build
npm start               # เทอร์มินัลที่ 2: API ที่ http://localhost:3000
```

สร้าง secret ด้วย `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` server จะไม่ยอมเปิดถ้า secret สั้นกว่า 32 ไบต์หรือใช้ค่าเดียวกัน

`db:dev` สร้างรหัสหน่วยงานทดสอบ `DEV-ORG`, `DEV-ORG-2` และ `DEV-ADMIN` (admin) ให้ ใช้ `node scripts/dev-db.js --fresh` เมื่อต้องการล้างข้อมูล

## ทดสอบ

```bash
npm test     # เปิด PostgreSQL 16 จริงจาก db/schema.sql เอง ไม่ mock ฐานข้อมูล
k6 run -e BASE_URL=http://localhost:3000 -e ORG_CODE=DEV-ORG load/claims.k6.js   # 300 นิสิตใน 60 วินาที
```

## ขึ้นเครื่องจริง

รอบนี้ยังไม่มี Dockerfile, Compose, Nginx และ backup รายวัน สิ่งที่ต้องเตรียมเอง:

1. PostgreSQL 16+ ที่สร้างฐานข้อมูลด้วย **encoding UTF8** (ไม่อย่างนั้นเก็บภาษาไทยไม่ได้) และไม่เปิด port สู่ภายนอก
2. รัน `db/schema.sql` แล้วเพิ่มหน่วยงานตามตัวอย่าง `db/seed-orgs.example.sql` โดยใช้รหัสยาวและเดายาก ห้าม commit รหัสจริง
3. ตั้ง env ตาม `.env.example`
4. อย่าตั้ง `API_DOCS=1` บนเครื่องจริง
5. วาง HTTPS proxy หน้า API ที่ส่งต่อ WebSocket ได้ และตั้ง **`TRUST_PROXY=1`** ไม่อย่างนั้นผู้ใช้ทุกคนจะถูกนับเป็น IP เดียวกันใน rate limit จนเข้าใช้ไม่ได้
6. ตั้ง backup ฐานข้อมูลรายวัน
7. รัน API เครื่องเดียวเท่านั้น เพราะ rate limit และ Socket.IO เก็บสถานะในหน่วยความจำ ถ้าจะขยายต้องเพิ่ม Redis adapter ก่อน

## จุดที่ต่างจากข้อกำหนด

ตกลงกับเจ้าของโปรเจกต์แล้ว รายละเอียดและเหตุผลอยู่ใน [docs/WORKLOG.md](docs/WORKLOG.md)

- `/auth/student` จำกัด 600 ครั้ง/นาที/IP แทน 20 เพราะนิสิตทั้งห้องใช้ IP เดียวกัน
- `orgCode` ส่งให้เฉพาะ admin และผู้ดูแลของหน่วยงานนั้น เพราะเป็นสิ่งเดียวที่ใช้ login เป็นผู้ดูแล
- เช็คชื่อด้วย QR ไม่ได้หลังส่งรายชื่อแล้ว (`ROSTER_LOCKED`)
- เหตุผลตอนให้หรือแก้ชั่วโมงบังคับเฉพาะเมื่อต่ำกว่าชั่วโมงเต็ม และ `POST /activities/:id/credits` รับ `reason` ด้วย
- `poster` ของรูปที่อัปโหลดอ่านได้เป็น URL (`GET /activities/:id/poster`) แทน data URL เพราะแทบทุกกิจกรรมอัปโหลดรูปเอง รับเข้าและเก็บเหมือนเดิม
- ไม่สร้าง notice "ได้รับ 0 ชั่วโมง"
- นิสิตไม่เห็น `deviceId`, `distance`, `accuracy` ของคนอื่น
- เปลี่ยนโหมด QR แล้วโหมดเดิมใช้ไม่ได้ทันที
- ลงทะเบียนกิจกรรมที่ซ่อน จบแล้ว ยังไม่ถึง `opensAt` เคยยกเลิกหลังกำหนด หรือถูกหักสิทธิ์ครบ 3 ครั้ง ได้ 409 (ข้อ 8.4 ไม่ได้ตรวจ)
- server เป็นผู้นับสิทธิ์ยกเลิก (`GET /students/:id/strikes`) และ admin ศูนย์คืนสิทธิ์ได้ (`PATCH /activities/:id/registrations/:studentId`) ข้อกำหนดไม่มีทั้งสองอย่าง

## ความเสี่ยงที่ยังเหลือ

- **`scannedAt` ปลอมได้:** ข้อ 8.2 ให้ตรวจ token กับเวลาที่ client ส่งมา คนที่มีรูป QR เก่าภายใน 48 ชั่วโมงจึงส่งเวลาย้อนหลังแล้วรับชั่วโมงได้ มีแค่ flag `offline` (และ `location` ถ้าอยู่ไกล) ให้ผู้ดูแลตรวจ
- **ไล่รหัสนิสิตได้:** `/auth/student` คืนชื่อของรหัสที่มีอยู่ จึงเก็บรายชื่อได้ถึง 600 รหัส/นาที/IP ต้องรอ SSO
- **สวมตัวนิสิตได้:** ใครรู้รหัสก็เข้าเป็นนิสิตคนนั้นได้ ตามที่ข้อกำหนดยอมรับไว้
- **รหัสหน่วยงานคือรหัสผ่านเดียว:** ถ้าถูกบอกต่อก็เข้าเป็นผู้ดูแลได้ ตามที่ข้อกำหนดยอมรับไว้
- **QR แบบ static ส่งต่อกันได้:** ถ่ายรูปแล้วส่งให้คนที่ไม่ได้มา ใช้ได้ตั้งแต่ 30 นาทีก่อนเริ่มถึง 30 นาทีหลังจบ มีแค่ flag `location` และ `device` ให้ผู้ดูแลตรวจ ถ้าต้องการกันจริงให้ใช้ dynamic
- **`x-request-id` มาจาก client:** server ใช้ค่านี้เป็น id ของ request ใน log ตรง ๆ คนเรียก API จึงตั้ง id ซ้ำหรือปลอมให้ log สับสนได้ ใช้ log ประกอบการสอบสวนต้องระวังข้อนี้
- **dependency ที่ `npm audit` แจ้ง (7 พ.ย. 2569):** `multer` (high, DoS ตอนอัปโหลดไฟล์) มากับ `@nestjs/platform-express` และ `uuid` (moderate) มากับ `exceljs` ระบบไม่มี endpoint อัปโหลดไฟล์ และ `exceljs` ไม่ได้เรียก `uuid` แบบที่มีช่องโหว่ จึงยังโจมตีไม่ได้ ห้ามใช้ `npm audit fix --force` เพราะจะเปลี่ยน major version (`@nestjs/platform-express` 12, `exceljs` 3) ให้รอ Nest 11 รุ่นที่แก้แล้วอัปเดตตามปกติ และรัน `npm audit --omit=dev` ก่อนขึ้นเครื่องจริงทุกครั้ง ฝั่งเว็บไม่พบช่องโหว่
- **ไม่มีคอลัมน์บันทึกผู้คืนสิทธิ์:** ข้อ 11 ห้ามแก้โครงสร้างตาราง ผู้คืนสิทธิ์จึงอยู่แค่ใน audit log (`supervisor write`) ต้องเก็บ log ไว้ถ้าต้องการตรวจย้อนหลัง
