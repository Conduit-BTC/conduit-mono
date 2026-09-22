import {
  orderAccountNetworkRelayRows,
  type AccountNetworkDesiredRelayRoles,
  type AccountNetworkRelayRowView,
} from "@conduit/core"

export function desiredRolesFromRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkDesiredRelayRoles[] {
  return rows.map((row) => ({
    url: row.url,
    readEnabled: row.readEnabled,
    publishEnabled: row.publishEnabled,
    privateInboxEnabled: row.privateInboxEnabled,
  }))
}

export function baselineRolesFromRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkDesiredRelayRoles[] {
  return rows.map((row) => ({
    url: row.url,
    readEnabled: row.readState === "published" || row.readState === "pending",
    publishEnabled:
      row.publishState === "published" || row.publishState === "pending",
    privateInboxEnabled:
      row.privateInboxState === "published" ||
      row.privateInboxState === "pending",
  }))
}

function rolesDiffer(
  baselineRoles: readonly AccountNetworkDesiredRelayRoles[],
  desiredRoles: readonly AccountNetworkDesiredRelayRoles[],
  select: (roles: AccountNetworkDesiredRelayRoles) => readonly boolean[]
): boolean {
  const baselineByUrl = new Map(
    baselineRoles.flatMap((roles) => {
      const selected = select(roles)
      return selected.some(Boolean) ? [[roles.url, selected] as const] : []
    })
  )
  const desiredByUrl = new Map(
    desiredRoles.flatMap((roles) => {
      const selected = select(roles)
      return selected.some(Boolean) ? [[roles.url, selected] as const] : []
    })
  )
  const urls = new Set([...baselineByUrl.keys(), ...desiredByUrl.keys()])
  for (const url of urls) {
    const baseline = baselineByUrl.get(url) ?? []
    const desired = desiredByUrl.get(url) ?? []
    if (baseline.length !== desired.length) return true
    if (baseline.some((value, index) => value !== desired[index])) return true
  }
  return false
}

function relayRoleWasEdited(
  localRow: AccountNetworkRelayRowView,
  previousControllerRow: AccountNetworkRelayRowView | undefined,
  role: "readEnabled" | "publishEnabled" | "privateInboxEnabled"
): boolean {
  return localRow[role] !== (previousControllerRow?.[role] ?? false)
}

/**
 * Adopt a new signed controller projection without turning stale editor rows
 * into implicit publish intent. Only explicit role edits and local candidates
 * survive; signed membership and presentation evidence come from the current
 * controller.
 */
export function reconcileRelaySettingsDraftRows(input: {
  previousControllerRows: readonly AccountNetworkRelayRowView[]
  localRows: readonly AccountNetworkRelayRowView[]
  nextControllerRows: readonly AccountNetworkRelayRowView[]
}): AccountNetworkRelayRowView[] {
  const previousByUrl = new Map(
    input.previousControllerRows.map((row) => [row.url, row])
  )
  const localByUrl = new Map(input.localRows.map((row) => [row.url, row]))
  const nextUrls = new Set(input.nextControllerRows.map((row) => row.url))
  const reconciled = input.nextControllerRows.map((nextRow) => {
    const localRow = localByUrl.get(nextRow.url)
    if (!localRow) return nextRow
    const previousControllerRow = previousByUrl.get(nextRow.url)
    return {
      ...nextRow,
      readEnabled: relayRoleWasEdited(
        localRow,
        previousControllerRow,
        "readEnabled"
      )
        ? localRow.readEnabled
        : nextRow.readEnabled,
      publishEnabled: relayRoleWasEdited(
        localRow,
        previousControllerRow,
        "publishEnabled"
      )
        ? localRow.publishEnabled
        : nextRow.publishEnabled,
      privateInboxEnabled: relayRoleWasEdited(
        localRow,
        previousControllerRow,
        "privateInboxEnabled"
      )
        ? localRow.privateInboxEnabled
        : nextRow.privateInboxEnabled,
    }
  })
  const retainedLocalRows = input.localRows.flatMap((localRow) => {
    if (nextUrls.has(localRow.url)) return []
    if (localRow.candidate) return [localRow]
    const previousControllerRow = previousByUrl.get(localRow.url)
    if (!previousControllerRow) return []
    const retainedRow: AccountNetworkRelayRowView = {
      ...localRow,
      readEnabled: relayRoleWasEdited(
        localRow,
        previousControllerRow,
        "readEnabled"
      )
        ? localRow.readEnabled
        : false,
      publishEnabled: relayRoleWasEdited(
        localRow,
        previousControllerRow,
        "publishEnabled"
      )
        ? localRow.publishEnabled
        : false,
      privateInboxEnabled: relayRoleWasEdited(
        localRow,
        previousControllerRow,
        "privateInboxEnabled"
      )
        ? localRow.privateInboxEnabled
        : false,
    }
    if (
      !retainedRow.readEnabled &&
      !retainedRow.publishEnabled &&
      !retainedRow.privateInboxEnabled
    )
      return []
    return [retainedRow]
  })

  return orderAccountNetworkRelayRows(
    [...reconciled, ...retainedLocalRows],
    input.localRows.map((row) => row.url)
  )
}

export function hasUnpublishedRelayRoleChanges(
  controllerRows: readonly AccountNetworkRelayRowView[],
  localRows: readonly AccountNetworkRelayRowView[]
): boolean {
  const baselineRoles = baselineRolesFromRows(controllerRows)
  const desiredRoles = desiredRolesFromRows(localRows)
  return (
    rolesDiffer(baselineRoles, desiredRoles, (roles) => [
      roles.readEnabled,
      roles.publishEnabled,
    ]) ||
    rolesDiffer(baselineRoles, desiredRoles, (roles) => [
      roles.privateInboxEnabled,
    ])
  )
}
