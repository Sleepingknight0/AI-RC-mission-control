# วิธีทำ Prototype แบบ Codex-Only

## ผู้รับผิดชอบ Prototype 0

Codex รับผิดชอบทุก milestone จนถึง M7.2:

```text
M0–M4  การวัดผล, vertical slice, durability, approval และ artifact
M5     frontend mission control และการตรวจ UX
M6     self-audit ด้าน correctness/recovery และ security/boundary
M7     แก้ finding, เพิ่ม regression test และ clean-checkout gate
```

Grok และ Claude ไม่ใช่ blocking gate อีกต่อไป สคริปต์และ prompt ของทั้งสอง
ยังเก็บไว้สำหรับ optional review หลัง Prototype 0 เท่านั้น

## หนึ่งรอบของ Loop

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\08-CODEX-ONLY-PROTOTYPE-LOOP.md
```

แต่ละรอบ Codex จะอ่าน milestone แรกที่ยังไม่เสร็จจาก
`docs/05-IMPLEMENTATION-STATUS.md`, ทำหนึ่ง milestone group, รัน checks,
อัปเดต execution plan และ handoff แล้วหยุด ห้ามเริ่ม milestone ถัดไปในรอบเดียว

## ลำดับอำนาจและหลักฐาน

เมื่อข้อมูลขัดกัน ให้ Codex ตัดสินตามลำดับ:

1. พฤติกรรม provider ที่วัดจริงและ generated schema
2. scope และ architecture decision ที่ยอมรับแล้ว
3. database constraint และ test ที่ reproduce ได้
4. active milestone prompt
5. long-form specification

ข้อเสนอจาก reviewer ต้อง reproduce หรือมีหลักฐานก่อนรับไปแก้

## Checkpoint ที่ปลอดภัย

ก่อนรอบให้ตรวจ `git status` หลังจบรอบให้รัน:

```powershell
pnpm check
git diff --check
.\scripts\Show-NextStep.ps1
```

สร้าง local commit ได้เมื่อ prompt อนุญาต, diff อยู่ในขอบเขต และ checks ผ่าน
ห้าม push อัตโนมัติ

## Optional หลัง Prototype 0

- P1: Grok ตรวจ visual hierarchy และ UX
- P2: Claude ทำ independent correctness/security audit
- P3: Codex reproduce, triage และรวมเฉพาะ feedback ที่พิสูจน์ได้

ห้าม reviewer ทำงานพร้อม Codex บน working tree เดียวกัน และห้ามเปลี่ยน backend
contract โดยไม่มีการตัดสินจาก Codex
