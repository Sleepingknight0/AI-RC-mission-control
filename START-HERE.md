# เริ่มใช้งาน

## 1. แตก ZIP และเปิดใน IDE

```powershell
cd C:\Projects
Expand-Archive .\aicl-mission-control-prototype-starter-v1.zip -DestinationPath .\aicl-mission-control
cd .\aicl-mission-control
git init
code .\AICL-Mission-Control.code-workspace
```

ถ้าแตก ZIP ด้วย Explorer ให้เปิดไฟล์ `AICL-Mission-Control.code-workspace` โดยตรง

## 2. ตรวจเครื่องมือ

```powershell
.\scripts\Check-Toolchain.ps1
```

ขั้นต่ำที่จำเป็นสำหรับ milestone แรก:

- Windows 10/11
- Git
- Node.js 20+
- Codex CLI ที่ login แล้ว

Grok Build และ Claude Code เป็น optional จนกว่าจะถึงขั้น frontend/audit

## 3. รัน empirical spike ก่อนเขียน product code

```powershell
.\scripts\Run-CodexSpike.ps1 -Runs 3
```

ผลอยู่ใน:

```text
spikes/codex-app-server/artifacts/<timestamp>/
```

จากนั้นให้ Codex สรุปผลลง `docs/measurements/CODEX-SPIKE-RESULTS.md`:

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\01-RUN-EMPIRICAL-SPIKE.md
```

## 4. สร้าง walking skeleton

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\02-SCAFFOLD-WALKING-SKELETON.md
```

จากนั้นทำ first-token vertical slice:

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\03-FIRST-TOKEN-VERTICAL-SLICE.md
```

หรือใช้ prompt กลางซ้ำทุกครั้ง เพื่อให้ Codex เลือก milestone แรกที่ยังไม่เสร็จ:

```powershell
.\scripts\Invoke-Codex.ps1
```

## 5. ให้ Grok ทำ frontend หลัง protocol types ใช้งานได้แล้ว

อย่าเริ่ม Grok frontend pass ก่อน `packages/protocol` และ mock fixtures คงที่

```powershell
.\scripts\Invoke-GrokFrontend.ps1
```

สคริปต์จะ copy คำสั่งลง clipboard และเปิด Grok แบบ interactive เพื่อให้คุณตรวจ permission ก่อนแก้ไฟล์

## 6. ให้ Claude ตรวจหลังแต่ละ vertical slice

```powershell
.\scripts\Invoke-ClaudeReview.ps1
```

Claude จะรันใน `plan` permission mode และบันทึกรายงานลง `reviews/claude/` โดยไม่แก้ source code

## 7. ให้ Codex รวมและแก้ผล review

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\06-INTEGRATE-GROK-AND-CLAUDE-FEEDBACK.md
```

## หลักการสำคัญ

- Codex เป็นผู้ถือ ownership ของ architecture, backend, provider adapter, database และ integration
- Grok แก้ได้เฉพาะ `apps/web`, `packages/ui-kit` และ frontend tests ตาม prompt
- Claude ตรวจและรายงาน ไม่แก้ source โดยค่าเริ่มต้น
- ไม่ให้ AI หลายตัวแก้ไฟล์ชุดเดียวกันพร้อมกัน
- ทุก milestone ต้องจบด้วยคำสั่งทดสอบและหลักฐานที่รันได้
