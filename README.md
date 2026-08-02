# AICL Mission Control — Prototype Starter Kit

ชุดเริ่มต้นสำหรับสร้าง **Prototype แรกที่ใช้งานได้จริง** ของ AICL Mission Control โดยใช้แนวทาง:

- **Codex** รับผิดชอบ implementation, frontend, self-audit และ integration ทั้งหมดจน Prototype 0 เสร็จ
- **Grok Build** และ **Claude Code** เป็น optional review หลัง Prototype 0
- สเปกฉบับเต็มเป็น reference ระยะยาว แต่ Prototype ทำเฉพาะ milestone ที่ระบุใน `docs/00-PROTOTYPE-0-SCOPE.md`

เริ่มจาก [START-HERE.md](START-HERE.md) และ [IDE workflow](docs/08-IDE-WORKFLOW.md) ส่วน milestone loop ดู [คู่มือภาษาไทย](docs/02-MULTI-AI-WORKFLOW-TH.md)

## คำสั่งหลัก

```powershell
# ตรวจเครื่องมือ
.\scripts\Check-Toolchain.ps1

# วัด Codex app-server บน Windows จริง 3 รอบ
.\scripts\Run-CodexSpike.ps1 -Runs 3

# ให้ Codex ทำ milestone ถัดไปแบบ Codex-only
.\scripts\Invoke-Codex.ps1

# Optional หลัง Prototype 0: ให้ Grok ตรวจ frontend
.\scripts\Invoke-GrokFrontend.ps1

# Optional หลัง Prototype 0: ให้ Claude audit แบบ read-only
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
Turn ซ้อนด้วย `TURN_ALREADY_ACTIVE` รวมทั้งแสดง command output, file diff และ
approval dock สำหรับ approve-once/decline โดยไม่เปิดเผย raw provider request ID
สคริปต์พัฒนาจะสร้าง Connector capability ใหม่ทุกครั้ง ส่วน browser ขอ ticket
อายุสั้นแบบใช้ครั้งเดียว จำกัด Origin แบบ exact match และไม่เก็บ token ถาวร

## M8 Daily-Use Operationalization

M8.1–M8.4 เสร็จแล้ว: หลัง Web build แล้ว Core จะเสิร์ฟ `apps/web/dist` พร้อม
hashed assets และ SPA fallback บน origin เดียวกับ `/ws`; production browser
จึงเลือก `ws:`/`wss:` จาก URL ของหน้าเว็บโดยอัตโนมัติ และขอ short-lived,
one-time ticket จาก `POST /runtime-config` ทุกครั้งที่ connect/reconnect โดยไม่
ฝัง browser token ใน JavaScript build ส่วน `pnpm dev` ใช้ `VITE_CORE_WS_URL`
เป็น development override เพื่อคง workflow แยกพอร์ตเดิม

ตรวจ production-host slice ได้ด้วย:

```powershell
pnpm --filter @aicl/web build
pnpm --filter @aicl/core exec vitest run test/production-host.test.ts
```

config version 1 ถูกสร้างแบบ atomic เมื่อเริ่ม Core/Connector ครั้งแรกที่:

```text
%LOCALAPPDATA%\AICL Mission Control\config.json
```

ไฟล์นี้กำหนด Core loopback host/port, Codex profile/CODEX_HOME, canonical
project allowlist/default project และตำแหน่ง Core DB, Connector DB, logs และ
backups โดยไม่เก็บ credential หรือ runtime capability ค่า environment สำหรับ
development/test จะ override เฉพาะใน memory และไม่ถูกเขียนกลับลงไฟล์

```json
{
  "version": 1,
  "core": {
    "host": "127.0.0.1",
    "port": 8787,
    "allowedBrowserOrigins": [
      "http://127.0.0.1:5173",
      "http://localhost:5173"
    ]
  },
  "connector": { "healthPort": 8788 },
  "provider": {
    "name": "codex",
    "profile": "default",
    "codexHome": "C:\\Users\\Operator\\.codex"
  },
  "workspace": {
    "allowedRoots": ["C:\\Projects"],
    "defaultProject": "C:\\Projects\\AI-RC-mission-control"
  },
  "paths": {
    "coreDatabase": "C:\\Users\\Operator\\AppData\\Local\\AICL Mission Control\\data\\aicl-core.db",
    "connectorDatabase": "C:\\Users\\Operator\\AppData\\Local\\AICL Mission Control\\data\\aicl-connector.db",
    "logs": "C:\\Users\\Operator\\AppData\\Local\\AICL Mission Control\\logs",
    "backups": "C:\\Users\\Operator\\AppData\\Local\\AICL Mission Control\\backups"
  }
}
```

environment override ที่รองรับคือ `AICL_CONFIG_PATH`, `AICL_CORE_HOST`,
`AICL_CORE_PORT`, `AICL_BROWSER_ORIGINS`, `AICL_CONNECTOR_PORT`,
`AICL_PROVIDER`, `AICL_CODEX_PROFILE`, `CODEX_HOME`, `AICL_PROJECT_ROOTS`,
`AICL_PROJECT_PATH`, `AICL_CORE_DB_PATH`, `AICL_CONNECTOR_DB_PATH`,
`AICL_LOG_DIR` และ `AICL_BACKUP_DIR` โดย Core origin ปัจจุบันจะถูกเพิ่มใน
effective allowlist อัตโนมัติโดยไม่เขียนค่าที่ derive แล้วกลับลงไฟล์

สร้างและควบคุม production processes ได้ด้วย:

```powershell
pnpm build
pnpm start
pnpm status
pnpm doctor
pnpm stop
```

`pnpm start` ใช้ JavaScript bundles ใต้ `build/production` โดยไม่เปิด Vite หรือ
`tsx watch`; หน้า production คือ `http://127.0.0.1:8787/` ตาม config ค่าเริ่มต้น
และ log แบบ JSON อยู่ใต้ LocalAppData ตาม `paths.logs` จำกัด 5 ไฟล์ × 5 MiB
ต่อ service พร้อม redaction ก่อนเขียน disk หากต้องการ build แล้ว start ในคำสั่ง
เดียวใช้ `pnpm start:production`

ติดตั้ง/ถอด auto-start สำหรับบัญชี operator ปัจจุบัน:

```powershell
pnpm startup:install
pnpm startup:uninstall
```

Task ใช้ interactive logon และ limited privilege เท่านั้น ไม่ใช้ LocalSystem
ตรวจ milestone ถัดไปด้วย `pnpm next` ส่วน `pnpm status` ใช้ดู production state

`pnpm backup` และ `pnpm restore` มี safety gate และจะหยุดด้วย exit code 2 จนกว่า
M8.6 จะเพิ่ม verified SQLite backup/restore; ห้ามแทนที่ด้วยการ copy ไฟล์ WAL ตรง ๆ

M8.5 มี private deployment automation แล้ว แต่ยังไม่ถือว่าเสร็จจนกว่าเครื่อง host
จะติดตั้ง/ล็อกอิน Tailscale เปิด HTTPS certificates ใน tailnet และผ่าน probe จาก
อุปกรณ์ตัวที่สองจริง ระบบจะไม่เรียก Funnel และ Core/Connector ยัง bind เฉพาะ
`127.0.0.1`

หลังติดตั้ง Tailscale และหยุดทั้ง `pnpm dev`/production stack ให้ตั้งค่าและเริ่มใหม่:

```powershell
pnpm remote:configure
pnpm start
pnpm remote:status
pnpm run doctor
```

คำสั่งแรก derive ชื่อเครื่องจาก `tailscale status --json`, persist เฉพาะ Origin
`https://<device>.<tailnet>.ts.net` และใช้ `tailscale serve --bg --yes
http://127.0.0.1:<core-port>` ถ้า tailnet ยังไม่เปิด HTTPS ให้ทำ consent ตาม
[Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve)

จาก Windows/laptop อีกเครื่องใน tailnet เดียวกัน ให้ copy script แล้วรัน probe
(ห้ามรันบน host เดิม):

```powershell
.\scripts\Test-TailscaleRemote.ps1 `
  -Origin 'https://<device>.<tailnet>.ts.net' `
  -EvidencePath '.\reviews\codex\M8.5-SECOND-DEVICE.json'
```

probe ตรวจ production HTML, Core/Connector health, short-lived runtime ticket และ
authenticated WSS โดยไม่บันทึก ticket ระยะ M8.6 ยังต้องเพิ่ม verified
backup/restore และ clean-install gate

Core และ Connector ใช้ SQLite คนละไฟล์ โดยค่าเริ่มต้นอยู่ใต้
`%LOCALAPPDATA%\AICL Mission Control\data` ตามลำดับ คำสั่ง
`pnpm migrate` รัน schema migrations ของทั้งสอง process ซ้ำได้อย่างปลอดภัย
Core commit durable state/event ก่อน broadcast ส่วน token deltas เป็น ephemeral
และ browser จะขอ replay จาก durable sequence ล่าสุดเมื่อ reconnect

Core schema version 4 เก็บ activity, file change, approval, artifact metadata
และลำดับแสดงผลข้ามชนิด event ส่วน Connector schema version 2 ใช้ journal
sequence แบบ FIFO พร้อม durable command receipts สถานะ terminal จะปิด activity
และ file change ที่ค้างให้ตรงกับ `completed`, `interrupted`, `failed` หรือ
`outcome_unknown` เสมอ
diff ไม่เกิน 512 KiB และ serialized envelope ไม่เกิน 768 KiB จึงส่ง inline;
ข้อมูลที่เกินเพดานใดเพดานหนึ่งถูกแบ่ง chunk ผ่าน Connector journal แล้วดาวน์โหลด
จาก `/artifacts/{artifactId}` ด้วย bearer token ชั่วคราว
endpoint รองรับ byte range แบบ bounded read ตรวจ byte length/SHA-256 และส่งเป็น
attachment ด้วย media type ที่อนุญาต โดยไม่รับ filesystem path

Connector ยอมรับ project root เฉพาะ canonical directory ใต้
`AICL_PROJECT_ROOTS` (คั่นหลาย path ด้วย `;` บน Windows) และส่ง environment
allowlist ให้ Codex child process เท่านั้น ใช้ `codex login`/credential store;
ตัวแปร secret อื่นจาก shell จะไม่ถูกส่งต่อโดยอัตโนมัติ

เปลี่ยนตำแหน่งฐานข้อมูล local ได้ด้วย:

```powershell
$env:AICL_CORE_DB_PATH = 'C:\path\to\core.db'
$env:AICL_CONNECTOR_DB_PATH = 'C:\path\to\connector.db'
pnpm dev
```

ฐานข้อมูล Prototype เดิมใต้ `.data` จะไม่ถูกย้ายอัตโนมัติใน M8.3 หากต้องใช้
ข้อมูลเดิมระหว่าง development ให้ตั้งสอง override ข้างบนก่อน `pnpm dev`;
M8.6 เป็นเจ้าของ backup, upgrade migration และ restore gate

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

## Clean-checkout final gate

ใช้ path แบบเต็มที่ไม่ผ่าน Windows 8.3 alias (เช่น `BLUEWH~1`) เพราะ pnpm
junctions ที่ติดตั้งผ่าน short-path อาจทำให้ Vite หา `/@vite/client` ไม่พบ:

```powershell
git clone . C:\Projects\aicl-final-check
cd C:\Projects\aicl-final-check
pnpm install --frozen-lockfile
pnpm --filter @aicl/connector codex:compatibility
pnpm migrate
pnpm migrate
pnpm check

$env:AICL_REAL_CODEX = '1'
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
```

จากนั้นรัน `pnpm dev`, เปิด `http://127.0.0.1:5173/?session=final-demo`
และตรวจ first token, approve/decline, command output, diff review, refresh/replay
และ Stop turn ตามหลักฐานใน `reviews/codex/M7.2-FINAL-GATE.md`.

## ทดสอบ Approval บน Browser/Mobile

```powershell
New-Item -ItemType Directory .\output\playwright -Force
pnpm dev
```

เปิด `http://127.0.0.1:5173/?session=m4-approval-demo` ด้วย viewport `390×844`
แล้วส่ง prompt นี้ (ใช้ session ID ใหม่เพื่อเริ่ม provider thread ใหม่):

```text
Use the shell exactly once to run PowerShell command Set-Content -LiteralPath 'output/playwright/approval-proof.txt' -Value 'approved'. Do not use any other tool and do not modify other files.
```

เมื่อ sticky dock ปรากฏ ให้ตรวจ command/cwd/expiry แล้วกด **Approve once**; activity
ต้องจบเป็น `completed` และไฟล์ proof ต้องมีค่า `approved` ทำซ้ำด้วยชื่อไฟล์ใหม่
แล้วกด **Decline**; activity ต้องเป็น `declined` และไฟล์นั้นต้องไม่ถูกสร้าง

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
