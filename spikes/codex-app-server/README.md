# AICL Codex app-server empirical spike

สไปก์นี้ใช้วัดพฤติกรรมของ `codex app-server --stdio` ที่ติดตั้งอยู่บนเครื่องจริง โดยไม่ถือว่าชื่อ method, event rate หรือ recovery semantics จากเอกสารเป็นความจริงถาวร

## สิ่งที่วัด

1. สร้าง JSON Schema จาก Codex binary ที่ติดตั้งจริงและคำนวณ SHA-256 fingerprint
2. เปิด app-server ผ่าน JSONL บน stdio และทำ initialization handshake
3. เปิด text-only turn แล้ววัด
   - latency จาก `turn/start` ถึง delta แรก
   - จำนวน delta ต่อวินาทีทั้งค่าเฉลี่ยและ rolling peak
   - distribution ของขนาด payload
   - inter-arrival time ของ delta
   - event count แยกตาม method
4. เปิด turn อีกตัวแล้ว terminate process tree ระหว่าง stream
5. เปิด app-server process ใหม่ แล้วเรียก `thread/read` และ `thread/resume`
6. บันทึก raw protocol traffic, generated schema, structured report และข้อสรุป recovery

สไปก์ไม่ส่ง prompt เดิมซ้ำหลัง crash และไม่ตีความว่า turn สำเร็จเพียงเพราะ process ตายหลังเกิด side effect

## ข้อกำหนด

- Windows PowerShell
- Node.js 20 ขึ้นไป
- Codex CLI ที่ login แล้ว
- project directory ที่ Codex เปิดอ่านได้

ตรวจสอบก่อน:

```powershell
node --version
codex --version
codex app-server generate-json-schema --out .\schema-check
```

## วิธีรัน

```powershell
cd .\aicl-codex-app-server-spike
.\run.ps1 -ProjectPath "C:\Projects\your-project"
```

ระบุ Codex executable หรือ model ได้:

```powershell
.\run.ps1 `
  -ProjectPath "C:\Projects\your-project" `
  -Codex "codex" `
  -Model "MODEL_ID"
```

หรือเรียก Node โดยตรง:

```powershell
node .\spike.mjs `
  --cwd "C:\Projects\your-project" `
  --out ".\artifacts\real-run" `
  --benchmark-turns 1 `
  --kill-after-deltas 5 `
  --kill-delay-ms 25
```

ตัวเลือกทั้งหมด:

```powershell
node .\spike.mjs --help
```

## ผลลัพธ์

แต่ละ run จะสร้างโฟลเดอร์ใหม่ใต้ `artifacts/`:

```text
artifacts/<timestamp>/
├─ schema/          schema จาก Codex version ที่รันจริง
├─ trace.jsonl      ทุก request, response, notification, stderr และ lifecycle event
├─ report.json      ผลดิบสำหรับนำไปวิเคราะห์ต่อ
└─ REPORT.md        สรุปสำหรับมนุษย์
```

อย่าแชร์ `trace.jsonl` โดยไม่ตรวจข้อมูลก่อน เพราะ provider event อาจมี prompt, path, command หรือข้อความจากโปรเจกต์

## วิธีอ่านตัวเลข

### Delta rate

ใช้ค่า peak rolling 1 second และ rolling 100 ms เพื่อกำหนดขนาด queue และ batching window ไม่ควรใช้ค่าเฉลี่ยอย่างเดียว เพราะ burst เป็นสิ่งที่ทำให้ WebSocket และ UI กระตุก

แนวทางเริ่มต้นหลังวัดจริง:

- `message.delta` และ `command.output.delta` เป็น ephemeral frame
- coalesce ทุก 20–50 ms สำหรับการส่ง UI
- checkpoint ข้อความสะสมทุก 250–500 ms หรือเมื่อเกิน 8–32 KiB
- persist `message.completed` เป็น authoritative full text
- durable event ทุกตัวต้อง commit ก่อน broadcast
- ephemeral frame broadcast ได้หลัง validation โดยไม่ต้องรอ database transaction

### Kill recovery

ตีความอย่างระมัดระวัง:

- พบ turn เป็น `completed` หลัง restart: provider persist completion แม้ client เดิมไม่เห็น terminal event
- พบสถานะ non-terminal: ต้องมี reconciliation; ห้าม auto-resubmit
- ไม่พบ turn: ไม่ได้แปลว่า provider ไม่ได้รับคำสั่ง
- `thread/read` และ `thread/resume` ล้มเหลวทั้งคู่: local command ต้องเป็น `outcome_unknown`

ทำ run ซ้ำอย่างน้อย 3 ครั้งก่อนล็อกสเปก เพราะ timing, model และ network เปลี่ยนผลได้

## Mock self-test

ทดสอบ logic ของสไปก์โดยไม่เรียก Codex จริง:

```powershell
npm run test:mock
```

บน Linux/macOS:

```bash
node spike.mjs \
  --codex ./test/mock-codex.mjs \
  --cwd . \
  --out ./artifacts/mock-test \
  --kill-after-deltas 3 \
  --kill-delay-ms 5
```

## ขอบเขตที่จงใจไม่ทำ

- ไม่วัด visual rendering performance ของ React
- ไม่วัด database transaction throughput
- ไม่ approve command หรือ file change; server-initiated approval request จะถูก decline
- ไม่ทดสอบ exactly-once เพราะ app-server ไม่ได้ให้ cross-process idempotency guarantee แก่ client
- ไม่สรุป provider behavior จาก run เดียว

## แหล่งอ้างอิงหลัก

- OpenAI Codex app-server README: protocol เป็น JSON-RPC ที่ตัด `jsonrpc` header ออก, stdio ใช้ JSONL, ต้อง initialize ก่อน และ schema ที่ generate ผูกกับ Codex version ที่รัน
- OpenAI Codex app-server README: `thread/start`, `turn/start`, streaming notifications, `thread/read`, `thread/resume` และ `turn/completed`

ใช้ generated schema ในโฟลเดอร์ผลลัพธ์เป็น source of truth สำหรับเครื่องนั้นเสมอ
