/** Reserved machine namespace, including unsupported or malformed future versions. */
export function isCheckoutSparkRecoveryMessageType(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("checkout_spark_")
}

export function isCheckoutSparkRecoveryMachineRumor(rumor: {
  tags?: readonly (readonly string[])[]
  content: string
}): boolean {
  if (
    rumor.tags?.some(
      (tag) => tag[0] === "type" && isCheckoutSparkRecoveryMessageType(tag[1])
    )
  )
    return true
  try {
    const body: unknown = JSON.parse(rumor.content)
    return (
      !!body &&
      typeof body === "object" &&
      "type" in body &&
      isCheckoutSparkRecoveryMessageType(body.type)
    )
  } catch {
    return false
  }
}
