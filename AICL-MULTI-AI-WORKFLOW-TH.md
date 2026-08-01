# วิธีแบ่งงานระหว่าง Codex, Grok และ Claude

## กติกาหลัก

ระบบนี้ใช้ AI หลายตัวแบบ **แบ่ง ownership** ไม่ใช่ให้ทุกตัวแก้โค้ดก้อนเดียวกันพร้อมกัน

```text
Codex   = ผู้พัฒนาหลัก + เจ้าของ integration
Grok    = ผู้เชี่ยวชาญ frontend/UX เมื่อ contract พร้อม
Claude  = ผู้ตรวจอิสระแบบ read-only
ผู้ใช้   = ผู้อนุมัติ scope, permission และ checkpoint
```

Codex ควรทำงานประมาณ 70–80% เพราะต้องรักษาความสอดคล้องระหว่าง Core, Connector, protocol, database, provider adapter และ tests

## เลือกตัวไหนตามสถานการณ์

| สถานการณ์ | ตัวนำ | เหตุผล |
|---|---|---|
| วัด Codex app-server จริงบน Windows | Codex | อยู่ใกล้ implementation และ generated schema ที่สุด |
| ออกแบบ protocol กลาง/state machine | Codex | เป็น contract ที่ทุกส่วนต้องใช้ร่วมกัน |
| Core, Connector, SQLite, recovery | Codex | ต้องแก้ข้ามหลาย package และรักษา invariant |
| ทำหน้าจอ mission control | Grok | ให้โฟกัส visual hierarchy, interaction และ responsive UI |
| ปรับ component, timeline, diff viewer | Grok | ทำได้เร็วเมื่อมี typed fixture และ protocol คงที่ |
| ตรวจ race condition/constraint/idempotency | Claude | ใช้เป็น reviewer คนละมุมกับผู้เขียนหลัก |
| ตรวจ security/recovery/failure semantics | Claude | เหมาะกับ adversarial review แบบไม่แก้ source |
| ตัดสินว่าข้อเสนอจาก Grok/Claude จะรับหรือไม่ | Codex | ต้อง reproduce กับ tests/schema/trace ก่อนรวม |
| final clean-checkout gate | Codex | เป็นผู้รับผิดชอบ integration ทั้งระบบ |

## ลำดับที่ต้องใช้

### ระยะ 1 — Codex ทำแกนระบบ

1. ตรวจ toolchain
2. รัน empirical spike จริงอย่างน้อยสามรอบ
3. บันทึก measurement
4. สร้าง monorepo walking skeleton
5. ทำ browser → Core → Connector → Codex first-token path
6. เพิ่ม SQLite, reconnect, idempotency, approval และ diff

ช่วงนี้ยังไม่ให้ Grok เปลี่ยน protocol และยังไม่ให้ Claude audit โครงเปล่า

### ระยะ 2 — Grok ทำ frontend

เริ่มเมื่อมีสิ่งต่อไปนี้แล้ว:

- `packages/protocol` build ผ่าน
- mock fixtures ครบ state สำคัญ
- Core มี normalized read model
- acceptance criteria สำหรับ timeline/approval/diff ชัดเจน

คำสั่ง:

```powershell
.\scripts\Invoke-GrokFrontend.ps1
```

Grok แก้ได้เฉพาะ frontend paths ที่กำหนด หากข้อมูล backend ไม่พอ ให้เขียน request ใน `reviews/grok/frontend-handoff.md` แทนการสร้าง field เอง

### ระยะ 3 — Claude ตรวจ

หลัง vertical slice รันได้:

```powershell
.\scripts\Invoke-ClaudeReview.ps1 `
  -PromptPath .\prompts\claude\01-ARCHITECTURE-CORRECTNESS-REVIEW.md

.\scripts\Invoke-ClaudeReview.ps1 `
  -PromptPath .\prompts\claude\02-SECURITY-RECOVERY-REVIEW.md
```

Claude ถูกจำกัดเป็น read-only และส่งรายงานลง `reviews/claude/`

### ระยะ 4 — Codex รวมผล

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\06-INTEGRATE-GROK-AND-CLAUDE-FEEDBACK.md
```

Codex ต้อง reproduce ทุก P0/P1 ก่อนแก้ พร้อมบันทึกว่า accepted, rejected, duplicate หรือ deferred และเพิ่ม regression test เมื่อรับข้อทัก

## Priority เมื่อมีงานด่วนหลายอย่าง

ใช้ลำดับนี้:

1. **ความปลอดภัยและความถูกต้องของ side effect** — duplicate command, stale approval, path escape
2. **ข้อมูลและ recovery** — event loss, wrong terminal state, `outcome_unknown`
3. **provider compatibility** — generated schema และ Windows process behavior
4. **เส้นทางหลักที่รันไม่ได้** — browser-to-provider, reconnect, interrupt
5. **UX ที่ทำให้ผู้ใช้สั่งผิด** — approval/diff/state ที่อ่านไม่ชัด
6. **ประสิทธิภาพ** — delta batching, long output, timeline
7. **ความสวยงามและ polish**

เมื่อข้อ 1–4 ยังไม่ผ่าน อย่าให้ visual polish ขยาย scope

## กฎป้องกัน AI ชนกัน

- ใช้ sequential mode เป็นค่าเริ่มต้น
- ห้ามเปิด Codex กับ Grok ให้แก้ working tree เดียวกันพร้อมกัน
- Claude ไม่แก้ source ระหว่าง audit
- Codex เป็นผู้แก้ backend contract เท่านั้นใน Prototype 0
- ทุก handoff ต้องระบุไฟล์, test, assumption, limitation และ next action
- commit checkpoint ด้วยตัวผู้ใช้หลังตรวจงาน ไม่ให้ agent commit โดยอัตโนมัติ

## เป้าหมายของการแบ่งงาน

ไม่ใช่ให้ AI สามตัวโหวตกัน แต่ให้:

```text
Codex สร้างและรวม
Grok ทำ frontend ใน contract ที่กำหนด
Claude พยายามทำให้สิ่งที่สร้างพังด้วยเหตุผลและหลักฐาน
Codex แก้เฉพาะข้อที่ reproduce ได้
```
