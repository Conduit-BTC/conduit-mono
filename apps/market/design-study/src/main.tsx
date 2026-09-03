import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { initializeTheme } from "../../../../packages/ui/src/theme"
import { StudyPage } from "./StudyPage"
import "../../../../packages/ui/src/styles/theme.css"
import "../../../../packages/ui/src/styles/typography.css"
import "./study.css"

// This is deliberately not Market's main.tsx. Theme is the only shared runtime.
initializeTheme()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudyPage />
  </StrictMode>
)
