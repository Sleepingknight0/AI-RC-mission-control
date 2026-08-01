# AICL Mission Control — Prototype Starter Kit

ชุดเริ่มต้นสำหรับสร้าง **Prototype แรกที่ใช้งานได้จริง** ของ AICL Mission Control โดยใช้แนวทาง:

- **Codex** เป็นผู้พัฒนาหลักและผู้รวมงาน
- **Grok Build** รับผิดชอบ frontend และ UX/UI แบบ aerospace mission control
- **Claude Code** ทำ independent audit แบบ read-only
- สเปกฉบับเต็มเป็น reference ระยะยาว แต่ Prototype ทำเฉพาะ milestone ที่ระบุใน `docs/00-PROTOTYPE-0-SCOPE.md`

เริ่มจาก [START-HERE.md](START-HERE.md) และ [IDE workflow](docs/08-IDE-WORKFLOW.md) ส่วนการแบ่งงานสาม AI ดู [คู่มือภาษาไทย](docs/02-MULTI-AI-WORKFLOW-TH.md)

## คำสั่งหลัก

```powershell
# ตรวจเครื่องมือ
.\scripts\Check-Toolchain.ps1

# วัด Codex app-server บน Windows จริง 3 รอบ
.\scripts\Run-CodexSpike.ps1 -Runs 3

# ให้ Codex ทำ milestone ถัดไป
.\scripts\Invoke-Codex.ps1

# ให้ Grok ทำ frontend pass หลัง protocol คงที่
.\scripts\Invoke-GrokFrontend.ps1

# ให้ Claude audit แบบ read-only
.\scripts\Invoke-ClaudeReview.ps1
```

## รัน Walking Skeleton

```powershell
pnpm install
pnpm migrate
pnpm dev
```

คำสั่งเดียวจะเปิด Web (`http://127.0.0.1:5173`), Core
(`http://127.0.0.1:8787/health`) และ Connector
(`http://127.0.0.1:8788/health`) เป็น process แยกกัน Connector ใช้
`codex app-server --stdio` และ repository root เป็น project path โดยค่าเริ่มต้น
หน้าเว็บส่ง prompt ผ่าน normalized WebSocket flow, รองรับ interrupt และปฏิเสธ
Turn ซ้อนด้วย `TURN_ALREADY_ACTIVE`

Core และ Connector ใช้ SQLite คนละไฟล์ โดยค่าเริ่มต้นอยู่ที่
`.data/aicl-core.db` และ `.data/aicl-connector.db` ตามลำดับ คำสั่ง
`pnpm migrate` รัน schema migrations ของทั้งสอง process ซ้ำได้อย่างปลอดภัย
Core commit durable state/event ก่อน broadcast ส่วน token deltas เป็น ephemeral
และ browser จะขอ replay จาก durable sequence ล่าสุดเมื่อ reconnect

เปลี่ยนตำแหน่งฐานข้อมูล local ได้ด้วย:

```powershell
$env:AICL_CORE_DB_PATH = 'C:\path\to\core.db'
$env:AICL_CONNECTOR_DB_PATH = 'C:\path\to\connector.db'
pnpm dev
```

ตรวจ binary/schema compatibility หรือสลับเป็น deterministic mock ได้ด้วย:

```powershell
pnpm --filter @aicl/connector codex:compatibility

$env:AICL_PROVIDER = 'mock'
pnpm dev
```

ตรวจทั้ง repository ด้วย:

```powershell
pnpm check
```

Real Codex end-to-end test ถูกปิดใน test suite ปกติเพื่อไม่ใช้เวลา/โควตาโดยไม่ตั้งใจ
เปิดเฉพาะเมื่อต้องการทดสอบ fault path จริง:

```powershell
$env:AICL_REAL_CODEX = '1'
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
```

## ลำดับอำนาจของเอกสาร

เมื่อเอกสารขัดกัน ให้ยึดตามลำดับนี้:

1. ผลการทดสอบจริงและ generated schema จาก Codex binary ที่ติดตั้ง
2. `docs/00-PROTOTYPE-0-SCOPE.md`
3. `docs/01-ARCHITECTURE-DECISIONS.md`
4. `AGENTS.md`
5. task prompt ที่กำลังรัน
6. `docs/spec/AICL-MISSION-CONTROL-SPEC-V2.2.md`
7. ข้อเสนอจาก AI ที่ยังไม่มีหลักฐาน

## เป้าหมายแรก

เส้นทางที่ต้องทำให้สำเร็จก่อนงานตกแต่ง:

```text
React browser
  -> AICL Core WebSocket
  -> AICL Connector
  -> codex app-server --stdio
  -> normalized message.delta
  -> browser แสดง token จริง
```

Prototype ต้องไม่พยายามทำทุกบทในสเปกพร้อมกัน
