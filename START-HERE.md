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

Grok Build และ Claude Code เป็น optional สำหรับ review หลัง Prototype 0 เท่านั้น

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

## 5. ทำ Codex-only loop จน Prototype 0 เสร็จ

รัน prompt เดิมซ้ำครั้งละหนึ่ง milestone:

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\08-CODEX-ONLY-PROTOTYPE-LOOP.md
```

ตรวจ `pnpm check`, `git diff --check` และ `Show-NextStep.ps1` หลังแต่ละรอบ

## 6. Optional review หลัง Prototype 0

```powershell
.\scripts\Invoke-GrokFrontend.ps1
.\scripts\Invoke-ClaudeReview.ps1
```

Grok/Claude ไม่ใช่ blocking gate Codex ต้อง reproduce และ triage feedback ก่อนรวม

## 7. ให้ Codex รวมผล optional review

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\06-INTEGRATE-GROK-AND-CLAUDE-FEEDBACK.md
```

## หลักการสำคัญ

- Codex ถือ ownership ของ Prototype 0 ทุกส่วน รวม frontend, self-audit และ final gate
- Grok/Claude ใช้หลัง Prototype 0 เป็น optional reviewer/refiner
- Claude ตรวจและรายงาน ไม่แก้ source โดยค่าเริ่มต้น
- ไม่ให้ AI หลายตัวแก้ไฟล์ชุดเดียวกันพร้อมกัน
- ทุก milestone ต้องจบด้วยคำสั่งทดสอบและหลักฐานที่รันได้
