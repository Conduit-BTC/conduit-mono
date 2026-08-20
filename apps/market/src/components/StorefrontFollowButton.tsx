import {
  Check,
  LoaderCircle,
  RotateCcw,
  UserMinus,
  UserPlus,
} from "lucide-react"

import { Button, cn } from "@conduit/ui"

import type { StorefrontFollowSaveState } from "../lib/storefront-follow-state"

type StorefrontFollowButtonProps = {
  isFollowing: boolean
  merchantName: string
  onClick: () => void
  retryAction: "follow" | "unfollow" | null
  saveState: StorefrontFollowSaveState
  unavailableDescriptionId?: string
  writesAvailable: boolean
}

export function StorefrontFollowButton({
  isFollowing,
  merchantName,
  onClick,
  retryAction,
  saveState,
  unavailableDescriptionId,
  writesAvailable,
}: StorefrontFollowButtonProps) {
  const isBusy = saveState !== "idle"
  const isSavingFollow = saveState === "saving_follow"
  const showFollowing = isFollowing || isBusy
  const showUnfollowAction =
    isFollowing && !isBusy && retryAction === null && writesAvailable
  const accessibleLabel = isSavingFollow
    ? `Following ${merchantName}`
    : saveState === "saving_unfollow"
      ? `Unfollowing ${merchantName}`
      : retryAction === "follow"
        ? `Retry follow ${merchantName}`
        : retryAction === "unfollow"
          ? `Retry unfollow ${merchantName}`
          : showUnfollowAction
            ? `Following ${merchantName}; Unfollow`
            : isFollowing
              ? `Following ${merchantName}`
              : `Follow ${merchantName}`

  return (
    <Button
      type="button"
      variant={showFollowing ? "outline" : "primary"}
      className={cn(
        "group h-11 max-w-full shrink-0 px-4 text-sm",
        showFollowing &&
          "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]",
        isBusy && writesAvailable && "disabled:opacity-100"
      )}
      onClick={onClick}
      disabled={!writesAvailable || isBusy}
      aria-busy={isBusy || undefined}
      aria-describedby={writesAvailable ? undefined : unavailableDescriptionId}
      aria-label={accessibleLabel}
    >
      {isBusy ? (
        <LoaderCircle
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : retryAction !== null ? (
        <RotateCcw className="size-4" aria-hidden="true" />
      ) : showUnfollowAction ? (
        <span
          className="relative grid size-4 place-items-center"
          aria-hidden="true"
        >
          <Check className="col-start-1 row-start-1 size-4 transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)]:group-hover:opacity-0 group-focus-visible:opacity-0" />
          <UserMinus className="col-start-1 row-start-1 size-4 opacity-0 transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)]:group-hover:opacity-100 group-focus-visible:opacity-100" />
        </span>
      ) : showFollowing ? (
        <Check className="size-4" aria-hidden="true" />
      ) : (
        <UserPlus className="size-4" aria-hidden="true" />
      )}

      {saveState === "saving_unfollow" ? (
        "Unfollowing…"
      ) : isSavingFollow ? (
        "Following…"
      ) : retryAction === "follow" ? (
        "Retry follow"
      ) : retryAction === "unfollow" ? (
        "Retry unfollow"
      ) : showUnfollowAction ? (
        <span className="grid" aria-hidden="true">
          <span className="col-start-1 row-start-1 transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)]:group-hover:opacity-0 [@media(hover:none)]:hidden group-focus-visible:opacity-0">
            Following
          </span>
          <span className="col-start-1 row-start-1 opacity-0 transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:hidden group-focus-visible:opacity-100">
            Unfollow
          </span>
          <span className="col-start-1 row-start-1 hidden [@media(hover:none)]:inline">
            Following · Unfollow
          </span>
        </span>
      ) : showFollowing ? (
        "Following"
      ) : (
        "Follow"
      )}
    </Button>
  )
}
