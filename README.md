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
