# สัญญา API ของ NU Volunteer Backend

เอกสารนี้สำหรับคนเขียน `src/data/remote.ts` ใหม่ ไฟล์นี้คือฉบับที่ใช้จริง ถ้าต่างจาก `/api/docs` ให้ยึดไฟล์นี้แล้วแจ้งเจ้าของ Backend

## 1. สิ่งที่หน้าเว็บต้องเปลี่ยน

หน้าจอส่วนใหญ่ไม่ต้องแก้เพราะเรียกผ่าน `api.ts` แต่จุดเหล่านี้เปลี่ยนพฤติกรรม:

| เรื่อง | เดิม | ใหม่ |
| --- | --- | --- |
| Token | ไม่มีตัวตนใน JWT | เก็บ token จาก `/auth/*` แล้วส่ง `Authorization: Bearer <token>` **ทุกคำขอ รวมถึง `GET /activities`** |
| `orgCode` ในกิจกรรม | ทุกคนเห็น | มีเฉพาะเมื่อเป็นผู้ดูแลของหน่วยงานนั้นหรือ admin ถ้าไม่ส่ง token ผู้ดูแลจะเห็นรายการว่าง เพราะ `visibleTo` กรองด้วยค่านี้ ให้เปลี่ยน type เป็น `orgCode?: string` |
| ล้าง field | ส่ง key ที่เป็น `undefined` | **ต้องแปลงเป็น `null`** เพราะ `JSON.stringify` ตัด `undefined` ทิ้ง (`toEdit` ใน `draft.ts` พึ่งเรื่องนี้) |
| อ่านแล้วไม่พบ | ได้ `null` | ได้ 404 ให้ `remote.ts` แปลงเป็น `null` |
| QR บนจอผู้ดูแล | `makeToken` ในเบราว์เซอร์ | `POST /activities/:id/qr` แล้วขอใหม่เมื่อถึง `refreshAt` (dynamic) |
| ตรวจ QR ตอนสแกน | `verifyToken` และ `precheck` | ส่ง token กับพิกัดดิบไป `POST /claims` แล้วอ่านผลหรือ error code ส่วน `payload.a` ยัง decode อ่านได้ แต่ไม่มี `h` (ชั่วโมง) แล้ว |
| เข้าสู่ระบบ | `getStudent`, `createStudent`, `getOrg` | `POST /auth/student` และ `POST /auth/sup` |
| ผู้ดูแลเพิ่มนิสิตใหม่ | `identify()` แล้ว `claim` | ส่ง `name` มากับ `POST /activities/:id/credits` หรือ `/bottles` เลย **ห้ามเรียก `/auth/student` จากฝั่งผู้ดูแล** |
| กิจกรรมขวด | `addBottles` เรียกหลายคำสั่ง | `POST /activities/:id/bottles` คำสั่งเดียว ไม่มี `setItems` แล้ว |
| ยกเลิกลงทะเบียน | หน้าเว็บส่ง `late` | server ตัดสินและคืน `{ late }` |
| notice `registered`, `credit` | หน้าเว็บส่ง `addNotice` | server สร้างเอง ให้ลบการเรียกออก ส่งเองได้เฉพาะ `open` |
| `markDmsRead` | ส่ง `readerIsSup` | server ดูจาก token |
| `listTemplates` | ส่ง `orgCode` | server ดูจาก token |
| Realtime | Supabase channel | Socket.IO ตามข้อ 6 รูปแบบเดิม: ได้สัญญาณแล้วโหลดใหม่ |

## 2. รูปแบบกลาง

- JSON ทั้งหมด ชื่อ field เป็น camelCase เวลาเป็นตัวเลข ms (UTC) รูปร่างตาม `src/data/types.ts`
- field ที่ไม่มีค่าจะไม่มี key ใน JSON
- `walkIn`, `late`, `waived` ของ Registration มีเฉพาะเมื่อเป็น `true`
- body ไม่เกิน 1 MB field ที่ไม่รู้จักถูกตัดทิ้งโดยไม่ error
- ใน PATCH: ไม่ส่ง key = ไม่แก้, ส่ง `null` = ล้างค่า (เฉพาะ field ที่ล้างได้)
- token นิสิตอายุ 30 วัน ผู้ดูแล 7 วัน เมื่อได้ 401 ให้เข้าสู่ระบบใหม่

### Error

```json
{ "error": { "code": "VALIDATION", "message": "ข้อมูลไม่ถูกต้อง", "fields": ["hours", "supervisor.name"] } }
```

`fields` มีเฉพาะบาง `VALIDATION` เช่น กรณี JSON เสียจะไม่มี `message` แสดงให้ผู้ใช้เห็นได้

| Status | code | เกิดเมื่อ |
| --- | --- | --- |
| 400 | `VALIDATION` | ข้อมูลผิดรูปแบบ, JSON เสีย |
| 400 | `QR_INVALID` | ลายเซ็นผิด, token เสีย, ไม่พบกิจกรรม, ชนิด QR ไม่ตรงกับโหมดปัจจุบันของกิจกรรม |
| 400 | `QR_EXPIRED` | dynamic หมดอายุ |
| 400 | `QR_EARLY`, `QR_LATE` | QR ทั้งสองแบบ ก่อน start − 30 นาที, หลัง end + 30 นาที |
| 401 | `UNAUTHENTICATED` | ไม่มี token, token ไม่ถูกต้องหรือหมดอายุ, รหัสหน่วยงานผิด |
| 403 | `FORBIDDEN` | ไม่มีสิทธิ์ |
| 403 | `NOT_REGISTERED` | กิจกรรมไม่รับ walk-in และไม่ได้ลงทะเบียน |
| 403 | `CHAT_DISABLED` | กิจกรรมปิดแชท |
| 404 | `NOT_FOUND` | ไม่พบ |
| 409 | `ROSTER_LOCKED` | ส่งรายชื่อหรือบันทึกแล้ว แก้ไม่ได้ หรือเช็คชื่อด้วย QR ไม่ได้แล้ว |
| 409 | `NOT_SUBMITTED` | บันทึกลงระบบก่อนส่งรายชื่อ |
| 409 | `NOT_BOTTLE` | ไม่ใช่กิจกรรมแลกขวด |
| 409 | `NOT_A_STRIKE` | คืนสิทธิ์ให้การลงทะเบียนที่ไม่ได้ถูกหักสิทธิ์ในภาคนี้ |
| 409 | `REG_HIDDEN` | ลงทะเบียนกิจกรรมที่ถูกซ่อน |
| 409 | `REG_ENDED` | ลงทะเบียนหลังกิจกรรมจบ |
| 409 | `REG_NOT_OPEN` | ลงทะเบียนก่อน `opensAt` |
| 409 | `REG_LATE_CANCELLED` | ลงทะเบียนซ้ำในกิจกรรมที่เคยยกเลิกหลังกำหนด |
| 409 | `REG_NO_CREDITS` | ลงทะเบียนเมื่อถูกหักสิทธิ์ครบ 3 ครั้งในภาคนี้ |
| 413 | `TOO_LARGE` | body เกิน 1 MB หรือรูปเกิน 300 KB |
| 429 | `RATE_LIMITED` | เรียกถี่เกิน: login ต่อ IP, `/claims` 10 ครั้ง/นาที/นิสิต, คำสั่งเขียนอื่น 60 ครั้ง/นาที ต่อผู้ใช้ต่อ endpoint (GET ไม่นับ) |
| 500 | `INTERNAL` | ข้อผิดพลาดภายใน |
| 503 | `DB_DOWN` | `/health` เท่านั้น |

### สิทธิ์

- **ทุกคน:** ไม่ต้องมี token (ถ้ามีก็ส่งได้)
- **นิสิต / ผู้ดูแล:** ตาม role ใน token
- **owner:** ผู้ดูแลที่ `orgCode` ตรงกับกิจกรรม
- **admin:** ผู้ดูแลจากหน่วยงานที่ `orgs.admin = true` ทำได้ทุกอย่างที่ owner ทำได้กับทุกกิจกรรม
- **self:** ข้อมูลของนิสิตคนนั้นเอง
- **กฎล็อก:** owner แก้ได้จนกว่าจะส่งรายชื่อ admin แก้ได้จนกว่าจะบันทึกลงระบบ เกินนั้นได้ 409 `ROSTER_LOCKED`

## 3. จับคู่ทั้ง 42 คำสั่งของ `api.ts`

| คำสั่ง | เรียก |
| --- | --- |
| `serverOffset` | คำนวณจาก `GET /time` |
| `getStudent` | `GET /students/:id` (404 → `null`) |
| `createStudent` | `POST /auth/student` พร้อม `name` |
| `getOrg` | `POST /auth/sup` |
| `getActivity` | `GET /activities/:id` (404 → `null`) |
| `getCredit` | `GET /activities/:id/credits/:studentId` (404 → `null`) |
| `getRegistration` | `GET /activities/:id/registrations/:studentId` (404 → `null`) |
| `watchActivities` | ห้อง `activities` + `GET /activities` |
| `watchCatalog` (ใหม่) | ห้อง `catalog` + `GET /activities` หน่วงสุ่ม 0–3 วินาที |
| `watchActivity` | ห้อง `activity:<id>` + `GET /activities/:id` |
| `watchRegistrations` | ห้อง `registrations:<id>` + `GET /activities/:id/registrations` |
| `watchCredits` | ห้อง `credits:<id>` + `GET /activities/:id/credits?order=desc` |
| `claim` | QR: `POST /claims` · เพิ่มเอง: `POST /activities/:id/credits` |
| `setHours` | `PATCH /activities/:id/credits/:studentId` |
| `setItems` | เลิกใช้ รวมใน `POST /activities/:id/bottles` |
| `removeCredit` | `DELETE /activities/:id/credits/:studentId` |
| `removeRegistration` | `DELETE /activities/:id/registrations/:studentId` |
| `studentStrikes` (ใหม่) | `GET /students/:id/strikes` |
| `setWaived` (ใหม่) | `PATCH /activities/:id/registrations/:studentId` |
| `closeRoster` | `POST /activities/:id/close` |
| `createActivity` | `POST /activities` |
| `updateActivity` | `PATCH /activities/:id` |
| `listActivities` | `GET /activities` |
| `listCredits` | `GET /activities/:id/credits` |
| `studentRegistrations` | `GET /students/me/registrations` |
| `studentCredits` | `GET /students/me/credits` |
| `register` | `POST /activities/:id/registrations` |
| `cancelRegistration` | `DELETE /activities/:id/registrations/me` |
| `updateStudent` | `PATCH /students/me` |
| `listNotices` | `GET /students/me/notices` |
| `addNotice` | `POST /students/me/notices` (เฉพาะ `open`) |
| `markNoticesRead` | `POST /students/me/notices/read` |
| `listAnnouncements` | `GET /activities/:id/announcements` |
| `listMessages` | `GET /activities/:id/messages` |
| `sendMessage` | `POST /activities/:id/messages` |
| `listDms` | `GET /activities/:id/dms/:studentId` |
| `sendDm` | `POST /activities/:id/dms/:studentId` |
| `markDmsRead` | `POST /activities/:id/dms/:studentId/read` |
| `listTemplates` | `GET /templates` |
| `createTemplate` | `POST /templates` |
| `updateTemplate` | `PATCH /templates/:id` |
| `deleteTemplate` | `DELETE /templates/:id` |
| `submitRoster` | `POST /activities/:id/submit` |
| `markRecorded` | `POST /activities/:id/record` |
| `creditHours` | `POST /stats/credit-hours` |

## 4. Endpoint

ชนิดข้อมูล `Activity`, `Credit`, `Registration`, `Notice` ฯลฯ ตาม `src/data/types.ts` ค่าในวงเล็บหลังชื่อ endpoint คือสิทธิ์ ถ้าไม่ระบุ status สำเร็จคือ 200

### ระบบและเข้าสู่ระบบ

**`GET /health`** (ทุกคน) → `{ "status": "ok", "db": "ok" }`

**`GET /time`** (ทุกคน) → `{ "now": 1793801644966 }`

**`POST /auth/student`** (ทุกคน, 600 ครั้ง/นาที/IP)

```jsonc
// ส่ง: name ใช้เฉพาะครั้งแรก รหัสที่มีอยู่แล้วใช้ชื่อเดิมในฐานข้อมูล
{ "studentId": "65012345", "name": "สมชาย ใจดี" }
// ได้: รหัสใหม่ได้ Student เต็ม
{ "token": "...", "student": { /* Student */ }, "isNew": true }
// รหัสที่มีอยู่แล้ว: เฉพาะ id, createdAt และชื่อที่ปิดบางส่วน (คำแรกเต็ม คำต่อไปไม่เกิน 3 ตัวอักษรและไม่เกินครึ่งคำ ตามด้วย •••)
{ "token": "...", "student": { "id": "65012345", "name": "สมชาย ใจ•••", "createdAt": 1793801000000 }, "isNew": false }
```

ชื่อที่ปิดไว้ใช้แสดงคำถาม "ใช่...ไหม" เท่านั้น เมื่อนิสิตยืนยันแล้วให้อ่านชื่อเต็มจาก `GET /students/:id` ด้วย token ที่ได้ (มาตรการชั่วคราวก่อนมี SSO ชื่อเต็มยังอยู่ใน payload ของ token)

รหัสใหม่แต่ไม่ส่งชื่อ (หรือชื่อว่าง) ได้ 404 ให้หน้าเว็บถามชื่อแล้วส่งใหม่

**`POST /auth/sup`** (ทุกคน, 5 ครั้ง/นาที/IP) รหัสไม่สนตัวพิมพ์และช่องว่าง

```jsonc
// ส่ง
{ "supName": "ผู้ดูแล ก", "orgCode": "xxxx" }
// ได้
{ "token": "...", "sup": { "name": "ผู้ดูแล ก", "orgCode": "XXXX", "orgName": "หน่วยงาน", "admin": false } }
```

### นิสิต

**`GET /students/:id`** (self, ผู้ดูแล) → `Student` ผู้ดูแลได้แค่ `id`, `name`, `createdAt`

**`GET /students/:id/strikes`** (self, admin) สิทธิ์ยกเลิกในภาคนี้ ตามกติกาในหัวข้อ "ลงทะเบียน" ผู้ดูแลที่ไม่ใช่ admin ได้ 403

```jsonc
{
  "limit": 3,
  "left": 1,
  "semester": { "number": 2, "start": 1793466000000, "end": 1809104400000 }, // end คือวันเริ่มภาคถัดไป
  "strikes": [ // ใหม่สุดก่อน รวมที่คืนแล้ว
    { "activityId": "abc", "title": "บริจาคโลหิต", "kind": "late", "at": 1794000000000, "waived": false } // kind: late หรือ noshow
  ]
}
```

**`PATCH /students/me`** (นิสิต) ส่ง `{ "reminders"?: string[], "notify"?: { enabled?, openings?, announcements?, messages? } }` → `Student`

**`GET /students/me/registrations`** (นิสิต) → `MyRegistration[]`

**`GET /students/me/credits`** (นิสิต) → `MyCredit[]`

**`GET /students/me/notices`** (นิสิต) → `Notice[]` ใหม่สุด 60 รายการ

**`POST /students/me/notices`** (นิสิต) 201 ส่ง `{ "kind": "open", "title": "...", "body"?: "...", "activityId"?: "...", "to"?: "/a/..." }` → `Notice`

**`POST /students/me/notices/read`** (นิสิต) → `{ "changed": 3 }`

### กิจกรรม

**`GET /activities`**, **`GET /activities/:id`** (ทุกคน) → `Activity[]`, `Activity` รวมที่ซ่อน หน้าเว็บกรองเอง `orgCode` ตามข้อ 1

**`POST /activities`** (ผู้ดูแล) 201 → `{ "id": "k3x9a0b1c2" }` รับ field ตาม `NewActivity` หน่วยงานมาจาก token

| field | กฎ |
| --- | --- |
| `title`, `categoryKey`, `start`, `end`, `hours`, `capLimit`, `capacity`, `walkIn`, `qrMode`, `locMode`, `radius`, `qrInterval`, `supervisor`, `chatEnabled` | ต้องมี |
| `categoryKey` | `blood`, `setup`, `bottle`, `other` |
| `start`, `end` | ms จำนวนเต็ม `end > start` |
| `hours` | จำนวนเต็ม 1–99 |
| `capacity` | 0–9999 |
| `qrMode` / `locMode` | `dynamic`, `static` / `on`, `off` |
| `radius` | 1–100000 |
| `qrInterval` | 10 หรือ 15 |
| `supervisor` | `{ name, phone }` name ห้ามว่าง |
| `poster`, `description`, `place` | ไม่บังคับ ค่าเริ่มต้นว่าง ห้าม `null` |
| `poster` | ว่าง, `./posters/<ชื่อ>.jpg` หรือ data URL `image/jpeg` ไม่เกิน 300 KB ถ้าไม่เปลี่ยนรูปให้ไม่ส่ง field นี้ |
| `lat`, `lng`, `opensAt`, `templateId`, `hidden`, `hideUntilOpen` | ไม่บังคับ ล้างด้วย `null` ได้ |
| `itemsPerHour` | 1–999 ล้างได้ |
| `cancelDays` | 0–14 ล้างได้ (ว่างถือเป็น 2) |
| `openChatUrl` | ขึ้นต้น `https://` ล้างได้ |

**`PATCH /activities/:id`** (owner/admin, กฎล็อก) field เดียวกับ POST ทุกตัวไม่บังคับ รวมถึงการซ่อน/แสดงด้วย `hidden` → `Activity`

**`poster` ใน `Activity` ที่อ่านได้** เป็นได้ 3 แบบ:

| รูปที่เก็บไว้ | ค่าที่ได้ |
| --- | --- |
| ไม่มีรูป | `""` |
| รูปในตัวเว็บ | `./posters/<ชื่อ>.jpg` |
| รูปที่อัปโหลด | `/activities/:id/poster?v=<เวอร์ชัน>` ให้เติมที่อยู่ของ API ด้านหน้า |

ส่ง URL นี้กลับมาใน POST หรือ PATCH ไม่ได้ จะได้ 400 เทมเพลตยังส่ง data URL เหมือนเดิม

**`GET /activities/:id/poster`** (สาธารณะ) → ไฟล์ JPEG มี `ETag` และ `Cache-Control: public, max-age=86400` ไม่มีรูปที่อัปโหลดได้ 404

**`GET /activities/:id/announcements`** (ทุกคน) → `Announcement[]` ใหม่สุดก่อน ไม่มี endpoint สร้างประกาศ

### QR

**`POST /activities/:id/qr`** (owner/admin) ส่งพิกัดจอถ้ามี `{ "la"?: 16.7, "lo"?: 100.2, "ac"?: 12 }` หลังส่งรายชื่อแล้วได้ 409

พิกัดใน token: static ใช้ `lat`/`lng` ของกิจกรรมก่อน (QR ที่พิมพ์มักพิมพ์ที่อื่น) ถ้าไม่มีจึงใช้พิกัดจอ ส่วน dynamic ใช้พิกัดจอก่อน ถ้าไม่มีจึงใช้ของกิจกรรม

```jsonc
// dynamic: ขอใหม่เมื่อเวลา server ถึง refreshAt
// upcoming: token ของ 5 นาทีถัดไป แต่ละตัวใช้ได้เมื่อถึง window ของมันเท่านั้น ให้จอสลับใช้เองตอนขอใหม่ไม่สำเร็จ
{ "token": "...", "url": "<WEB_ORIGIN>/#/claim?t=...", "mode": "dynamic", "interval": 10, "window": 179380164, "refreshAt": 1793801650000, "now": 1793801644966,
  "upcoming": [{ "window": 179380165, "token": "...", "url": "..." } /* ... */] }
// static: ใช้ได้ตั้งแต่ start − 30 นาที ถึง end + 30 นาที
{ "token": "...", "url": "...", "mode": "static", "now": 1793801644966 }
```

เปลี่ยน `qrMode` ของกิจกรรมแล้ว QR ชนิดเดิมจะใช้ไม่ได้ทันที (`QR_INVALID`)

### เช็คชื่อ

**`POST /claims`** (นิสิต, 10 ครั้ง/นาที/รหัสนิสิต)

```jsonc
// ส่ง: lat/lng/accuracy ไม่บังคับ แต่ไม่ส่งจะติด flag location
//      scannedAt = เวลาที่เปิดลิงก์ (เวลา server เป็น ms ทศนิยมได้) ส่งทุกครั้งที่หน้าเว็บรู้เวลา server แล้ว QR จึงไม่หมดอายุระหว่างกรอกฟอร์ม
//      offline: true เฉพาะสแกนที่เก็บไว้ตอนออฟไลน์แล้วส่งทีหลัง
//      flag offline ติดเมื่อส่ง offline: true หรือ scannedAt เก่ากว่า 3 นาที
{ "token": "...", "lat": 16.74, "lng": 100.19, "accuracy": 15, "deviceId": "d-7f2c", "scannedAt": 1793801000000, "offline": true }
// สำเร็จ
{ "ok": true, "credit": { /* Credit */ } }
// ได้ชั่วโมงไปแล้ว (status 200 เช่นกัน)
{ "ok": false, "reason": "already", "credit": { /* แถวเดิม */ } }
```

error: `QR_INVALID`, `QR_EXPIRED`, `QR_EARLY`, `QR_LATE`, `NOT_REGISTERED`, `ROSTER_LOCKED`

ตำแหน่งไม่เคยบล็อก แค่ติด flag การเก็บสแกนออฟไลน์ควรลองใหม่เฉพาะเมื่อเน็ตล่มหรือได้ 5xx/429 ถ้าได้ 4xx อื่นให้เลิกส่งแล้วแจ้งผู้ใช้

### ลงทะเบียน

**`POST /activities/:id/registrations`** (นิสิต) → `{ "result": "ok" | "full" | "already" }`

ตรวจตามลำดับ: ลงทะเบียนอยู่แล้วได้ `already` เสมอ จากนั้นกิจกรรมที่ `hidden` ได้ 409 `REG_HIDDEN`, เลย `end` ได้ 409 `REG_ENDED`, ยังไม่ถึง `opensAt` ได้ 409 `REG_NOT_OPEN`, เคยยกเลิกกิจกรรมนี้หลังกำหนดได้ 409 `REG_LATE_CANCELLED`, สิทธิ์หมดได้ 409 `REG_NO_CREDITS` แล้วจึงตรวจที่นั่งเต็ม กฎนี้ไม่ใช้กับการเพิ่มคนโดยผู้ดูแลและ walk-in จากการสแกน

**การนับสิทธิ์ที่ถูกหัก** นับในภาคปัจจุบัน (ภาค 1 คือ 1 พ.ค. ถึง 31 ต.ค., ภาค 2 คือ 1 พ.ย. ถึง 30 เม.ย. ตาม `TZ_DISPLAY`) ครบ 3 ครั้งแล้วลงทะเบียนไม่ได้

| นับ 1 ครั้ง | ไม่นับ |
| --- | --- |
| ยกเลิกหลังกำหนด นับจากเวลาที่ยกเลิก | ยกเลิกทันเวลา |
| ลงทะเบียนแล้วไม่มี credit เมื่อรายชื่อปิด (ผู้ดูแลปิด หรือ 24 ชั่วโมงหลังจบ) | มี credit แม้ 0 ชั่วโมง, walk-in, แถวที่ `waived` |

กฎนี้อยู่ที่ `src/modules/roster/strikes.ts` ที่เดียว ใช้ทั้งตอนตรวจการลงทะเบียนและใน `GET /students/:id/strikes` หน้าเว็บอ่านจาก endpoint นี้ ไม่นับเอง

**`DELETE /activities/:id/registrations/me`** (นิสิต) → `{ "late": true }` ไม่มีการลงทะเบียนที่ใช้งานอยู่ได้ 404

**`GET /activities/:id/registrations`** (owner/admin) → `Registration[]` ใหม่สุดก่อน

**`GET /activities/:id/registrations/:studentId`** (self, owner/admin) → `Registration`

**`DELETE /activities/:id/registrations/:studentId`** (owner/admin, กฎล็อก) ลบพร้อมชั่วโมง → `{ "ok": true }`

**`PATCH /activities/:id/registrations/:studentId`** (admin) ส่ง `{ "waived": true }` เพื่อคืนสิทธิ์ หรือ `false` เพื่อยกเลิกการคืน → `Registration` ใช้ได้เฉพาะรายการที่อยู่ใน `strikes` ของภาคนี้ ไม่อย่างนั้นได้ 409 `NOT_A_STRIKE` ไม่มีการลงทะเบียนได้ 404 ไม่ติดกฎล็อก ผู้ที่คืนสิทธิ์ถูกบันทึกใน audit log

### ชั่วโมง

**`GET /activities/:id/credits?order=asc|desc`** (นิสิตทุกคน, owner/admin) → `Credit[]` ค่าเริ่มต้นเก่าสุดก่อน แถวของคนอื่นที่นิสิตเห็นมีแค่ `studentId`, `name`, `hours`, `fullHours`, `at`, `method`

**`GET /activities/:id/credits/:studentId`** (self, owner/admin) → `Credit`

**`POST /activities/:id/credits`** (owner/admin, กฎล็อก) เพิ่มเอง

```jsonc
// ส่ง: name จำเป็นเฉพาะนิสิตที่ยังไม่มีในระบบ, hours ไม่ส่ง = เต็ม (0 ถึงชั่วโมงของกิจกรรม)
// reason ต้องมีเมื่อ hours ต่ำกว่าชั่วโมงเต็ม ไม่อย่างนั้นได้ 400 VALIDATION และไม่มีการเขียนใด ๆ
{ "studentId": "65012345", "name": "สมชาย ใจดี", "hours": 3, "reason": "กลับก่อน" }
// ได้: รูปแบบเดียวกับ POST /claims
{ "ok": true, "credit": { /* Credit */ } }
```

**`PATCH /activities/:id/credits/:studentId`** (owner/admin, กฎล็อก) ส่ง `{ "hours": 3, "reason": "กลับก่อน" }` → `Credit` ต้องมี `reason` เมื่อ `hours` ต่ำกว่าชั่วโมงเต็ม ถ้าชั่วโมงเปลี่ยน server สร้าง notice `credit` "ชั่วโมงเปลี่ยนเป็น X ชั่วโมง" (หรือ "ได้รับ X ชั่วโมง" ถ้าเดิมเป็น 0) แลกขวดก็เช่นกัน

**`DELETE /activities/:id/credits/:studentId`** (owner/admin, กฎล็อก) → `{ "ok": true }`

**`POST /activities/:id/bottles`** (owner/admin, กฎล็อก) ส่ง `{ "studentId": "...", "name"?: "...", "add": 5 }` → `{ "items": 25, "hours": 1, "credit": { /* Credit */ } }`

### วงจรรายชื่อ

| Endpoint | สิทธิ์ | ผล |
| --- | --- | --- |
| `POST /activities/:id/close` | owner/admin | `{ "changed": true }` ถ้าปิดไปแล้วได้ `false` |
| `POST /activities/:id/submit` | owner/admin | `{ "changed": true }` ถ้าส่งไปแล้วได้ `false` |
| `POST /activities/:id/record` | admin | `{ "changed": true }` ถ้าบันทึกไปแล้วได้ `false` ยังไม่ส่งได้ 409 `NOT_SUBMITTED` |

**`GET /activities/:id/export?kind=sup|admin`** ไฟล์ `.xlsx` `kind=sup` สำหรับ owner/admin ส่วน `kind=admin` สำหรับ admin ชื่อไฟล์อยู่ใน header `Content-Disposition` (`filename*`) ต้องดาวน์โหลดด้วย `fetch` เพราะต้องแนบ token

**`POST /stats/credit-hours`** (admin) ส่ง `{ "activityIds": ["a", "b"] }` → `{ "a": 120, "b": 0 }`

### แชทและข้อความส่วนตัว

**`GET /activities/:id/messages`** (ทุกคนที่ login) → `ChatMsg[]` 500 ข้อความล่าสุด เก่าสุดก่อน

**`POST /activities/:id/messages`** (นิสิต, owner/admin) 201 ส่ง `{ "text": "..." }` (1–2000 ตัว) → `ChatMsg` ผู้เขียนมาจาก token ปิดแชทได้ 403 `CHAT_DISABLED`

**`GET /activities/:id/dms`** (owner/admin) รายการ thread ใหม่สุดก่อน

```json
[{ "studentId": "65012345", "name": "สมชาย", "lastText": "...", "lastAt": 1793801000000, "lastFromSup": false, "unread": 2 }]
```

**`GET /activities/:id/dms/:studentId`** (self, owner/admin) → `DirectMsg[]` เก่าสุดก่อน

**`POST /activities/:id/dms/:studentId`** (self, owner/admin) 201 ส่ง `{ "text": "..." }` → `DirectMsg`

**`POST /activities/:id/dms/:studentId/read`** (self, owner/admin) ทำเครื่องหมายข้อความของอีกฝั่ง → `{ "changed": 1 }`

### เทมเพลต (ผู้ดูแล, เฉพาะหน่วยงานตัวเอง)

| Endpoint | ส่ง | ได้ |
| --- | --- | --- |
| `GET /templates` | | `Template[]` เก่าสุดก่อน |
| `POST /templates` (201) | `{ title, hours, poster?, description?, settings? }` | `Template` |
| `PATCH /templates/:id` | field เดียวกัน ไม่บังคับทุกตัว | `Template` |
| `DELETE /templates/:id` | | `{ "ok": true }` |

`settings` ที่ขาดใช้ค่าเริ่มต้น: capacity 30, qrMode dynamic, qrInterval 10, locMode on, radius 150

## 5. รูปแบบ QR token

`base64url(JSON) + "." + base64url(HMAC-SHA256 ตัด 12 ไบต์แรก)` ไม่มี padding หน้าเว็บไม่มี secret จึงเซ็นหรือตรวจเองไม่ได้ แต่อ่านส่วนแรกเพื่อรู้รหัสกิจกรรมได้

```json
{ "v": 3, "a": "<activityId>", "w": 179380164, "i": 15, "la": 16.7, "lo": 100.2, "ac": 12 }
```

`w` มีเฉพาะ dynamic, `s: 1` มีเฉพาะ static, `i` มีเมื่อ interval ไม่ใช่ 10, `la`/`lo` มีเมื่อกิจกรรมตรวจตำแหน่งและจอหรือกิจกรรมมีพิกัด `ac` มีเมื่อใช้พิกัดจอ

URL ใน QR: `<WEB_ORIGIN>/#/claim?t=<token>`

## 6. Realtime (Socket.IO)

```js
import { io } from 'socket.io-client'

const socket = io(API_URL, { auth: { token } }) // token ไม่บังคับ
const join = () => socket.emit('join', { room: `credits:${id}` }, (ack) => { /* { ok: true } หรือ { ok: false, code } */ })

// เหตุการณ์ระหว่างเน็ตหลุดจะหาย: join ใหม่และโหลดใหม่ทุกครั้งที่เชื่อมต่อ
socket.on('connect', () => { join(); reload() })
socket.on('changed', ({ room }) => reload())
socket.on('error', ({ room, code }) => { /* FORBIDDEN, UNAUTHENTICATED, INVALID_ROOM */ })

socket.emit('leave', { room: `credits:${id}` })
```

| ห้อง | ใครเข้าได้ | ได้สัญญาณเมื่อ |
| --- | --- | --- |
| `activities` | ทุกคน | กิจกรรมใดเปลี่ยน (รวมตัวนับเมื่อมีคนสแกน) |
| `catalog` | ทุกคน | สร้างหรือแก้กิจกรรมเท่านั้น ไม่ส่งตอนสแกน หน้าแรกนิสิตใช้ห้องนี้ |
| `activity:<id>` | ทุกคน | แถวกิจกรรมหรือตัวนับเปลี่ยน |
| `registrations:<id>` | owner/admin | รายชื่อลงทะเบียนเปลี่ยน |
| `credits:<id>` | นิสิตทุกคน, owner/admin | ชั่วโมงเปลี่ยน |
| `messages:<id>` | ทุกคนที่ login | มีแชทใหม่ |
| `dms:<id>` | owner/admin | thread ใดของกิจกรรมเปลี่ยน |
| `dms:<id>:<studentId>` | self, owner/admin | thread นี้เปลี่ยน |

- `changed` ส่งหลัง commit เท่านั้น และรวมเหตุการณ์ของห้องเดียวกันใน 200 ms เป็นครั้งเดียว
- token ถูกตรวจใหม่ทุกครั้งที่ `join` ถ้าหมดอายุให้สร้าง socket ใหม่ด้วย token ใหม่
- ถ้าเปลี่ยนจาก anonymous เป็น login แล้ว ต้องสร้าง socket ใหม่เช่นกัน
