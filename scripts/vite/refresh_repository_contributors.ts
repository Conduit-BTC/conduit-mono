import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { fetchRepositoryContributorSnapshot } from "./repository_contributors"

async function readGitHubToken(): Promise<string> {
  const configuredToken =
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  if (configuredToken) return configuredToken

  const tokenProcess = Bun.spawn(["gh", "auth", "token"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const token = (await new Response(tokenProcess.stdout).text()).trim()
  if ((await tokenProcess.exited) !== 0 || !token) {
    throw new Error(
      "Contributor refresh requires GITHUB_TOKEN, GH_TOKEN, or an authenticated gh CLI."
    )
  }
  return token
}

const token = await readGitHubToken()
const snapshot = await fetchRepositoryContributorSnapshot({ token })
const targetPath = fileURLToPath(
  new URL("./repository_contributors.generated.json", import.meta.url)
)

await writeFile(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
console.log(
  `Refreshed ${snapshot.contributors.length} human contributors through ${snapshot.sourceRevision?.slice(0, 12)}.`
)
