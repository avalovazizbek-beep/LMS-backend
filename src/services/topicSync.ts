import { pool } from "./db"
import { listTeacherContent, duplicateTeacherContent, contentSlot } from "./teachingStore"
import { listQuestions, replaceQuestions } from "./examStore"

/**
 * Mavzuni (fayllari, test savollari bilan) boshqa guruhlarga moslaydi: guruhda
 * shu nom va turdagi mavzu bo'lmasa yaratadi, bor bo'lsa faqat yetishmayotgan
 * qismlarini qo'shadi. Hech narsani o'chirmaydi/almashtirmaydi — guruhdagi
 * mavjud test/topshiriqqa tegilmaydi (talaba natijalari saqlanadi).
 * `groupIds` — chaqiruvchi tekshirgan (o'qituvchining o'z) guruhlari.
 */
export async function syncTopicToGroups(
  teacherUserId: number, topicKey: string, groupIds: number[]
): Promise<{ topicsCreated: number; itemsCopied: number } | null> {
  const source = await listTeacherContent({ topicKey, teacherUserId })
  const marker = source.find((i) => i.type === "mavzu" && i.kind === "topic")
  if (!marker) return null
  const title = marker.title.trim().toLowerCase()
  const type = marker.trainingType?.trim() || null

  let topicsCreated = 0
  let itemsCopied = 0
  for (const groupId of groupIds.filter((g) => g !== marker.groupId)) {
    const groupItems = await listTeacherContent({ teacherUserId, groupId, subjectName: marker.subjectName })
    let target = groupItems.find((i) =>
      i.type === "mavzu" && i.kind === "topic" && i.title.trim().toLowerCase() === title && (i.trainingType?.trim() || null) === type)
    if (!target) {
      target = await duplicateTeacherContent(marker, { groupId, topicKey: `${marker.subjectName}__${groupId}__${Date.now()}` })
      topicsCreated++
    }
    const targetItems = groupItems.filter((i) => i.topicKey === target!.topicKey)
    const have = new Set(targetItems.map(contentSlot))
    let hasGraded = targetItems.some((i) => i.type === "exam" || i.type === "assignment")
    for (const item of source) {
      if (item.id === marker.id || have.has(contentSlot(item))) continue
      // Eski xato bilan saqlangan online dars ("#" — dars ID'si yo'q) — nusxalashdan foyda yo'q
      if (item.kind === "meeting" && !/^\d+$/.test(item.meetingLink ?? "")) continue
      if ((item.type === "exam" || item.type === "assignment") && hasGraded) continue
      const copy = await duplicateTeacherContent(item, { groupId, topicKey: target.topicKey! })
      if (item.type === "exam") {
        const questions = await listQuestions(item.id)
        if (questions.length) await replaceQuestions(copy.id, questions)
      }
      if (item.type === "exam" || item.type === "assignment") hasGraded = true
      // Online dars — yangi guruh talabalari ham darsga kira olsin
      if (item.kind === "meeting" && /^\d+$/.test(item.meetingLink ?? "")) {
        await pool.query("INSERT IGNORE INTO lms_meeting_groups (meeting_id, group_id) VALUES (?, ?)", [Number(item.meetingLink), groupId])
      }
      have.add(contentSlot(item))
      itemsCopied++
    }
  }
  return { topicsCreated, itemsCopied }
}
