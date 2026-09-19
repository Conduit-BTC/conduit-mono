export type ProtectedInboxNoticeState =
  "complete" | "cached" | "partial" | "unavailable"

export type ProtectedInboxNoticeSubject = "messages" | "orders" | "activity"

export type ProtectedInboxNoticePresentation = {
  message: string
  unavailable: boolean
}

function subjectCopy(subject: ProtectedInboxNoticeSubject) {
  switch (subject) {
    case "orders":
      return {
        saved: "Showing saved orders.",
        missing: "Some recent order updates may be missing.",
        unavailable:
          "Order updates couldn't be loaded. Retry before relying on an empty order list.",
        decrypt: "order update",
      }
    case "activity":
      return {
        saved: "Showing saved buyer activity.",
        missing: "Some recent buyer activity may be missing.",
        unavailable:
          "Latest buyer activity couldn't be loaded. Retry before relying on an empty activity list.",
        decrypt: "activity update",
      }
    case "messages":
    default:
      return {
        saved: "Showing saved messages.",
        missing: "Some recent messages may be missing.",
        unavailable:
          "Messages couldn't be loaded. Retry before relying on an empty inbox.",
        decrypt: "message",
      }
  }
}

export function getProtectedInboxNoticePresentation(input: {
  state: ProtectedInboxNoticeState
  subject?: ProtectedInboxNoticeSubject
  decryptFailureCount?: number
}): ProtectedInboxNoticePresentation | null {
  const copy = subjectCopy(input.subject ?? "messages")
  const decryptFailureCount = Math.max(0, input.decryptFailureCount ?? 0)
  const decryptCopy =
    decryptFailureCount > 0
      ? `${decryptFailureCount} ${copy.decrypt}${decryptFailureCount === 1 ? "" : "s"} couldn't be opened.`
      : ""

  if (input.state === "complete") {
    return decryptCopy ? { message: decryptCopy, unavailable: false } : null
  }

  if (input.state === "unavailable") {
    return {
      message: [copy.unavailable, decryptCopy].filter(Boolean).join(" "),
      unavailable: true,
    }
  }

  const resultCopy =
    input.state === "cached" ? `${copy.saved} ${copy.missing}` : copy.missing
  return {
    message: [resultCopy, decryptCopy].filter(Boolean).join(" "),
    unavailable: false,
  }
}
