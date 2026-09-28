import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Plugin, ResolvedConfig } from "vite"

interface AboutMetadataOptions {
  homeTitle: string
  homeDescription: string
  origin: string
  aboutTitle: string
  aboutDescription: string
}

export function createAboutMetadataPlugin(
  options: AboutMetadataOptions
): Plugin {
  let config: ResolvedConfig

  return {
    name: "conduit-about-metadata",
    apply: "build",
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    async closeBundle() {
      const outputDir = resolve(config.root, config.build.outDir)
      const source = await readFile(resolve(outputDir, "index.html"), "utf8")
      const homeUrl = `${options.origin}/`
      const aboutUrl = `${options.origin}/about`

      if (
        !source.includes(options.homeDescription) ||
        !source.includes(`<title>${options.homeTitle}</title>`) ||
        !source.includes(`href="${homeUrl}"`)
      ) {
        throw new Error(
          "About metadata source HTML no longer matches the app homepage"
        )
      }

      const aboutHtml = source
        .replaceAll(options.homeDescription, options.aboutDescription)
        .replace(
          `property="og:title" content="${options.homeTitle}"`,
          `property="og:title" content="${options.aboutTitle}"`
        )
        .replace(
          `name="twitter:title" content="${options.homeTitle}"`,
          `name="twitter:title" content="${options.aboutTitle}"`
        )
        .replace(
          `<title>${options.homeTitle}</title>`,
          `<title>${options.aboutTitle}</title>`
        )
        .replace(`content="${homeUrl}"`, `content="${aboutUrl}"`)
        .replace(`href="${homeUrl}"`, `href="${aboutUrl}"`)

      await writeFile(resolve(outputDir, "about.html"), aboutHtml)
    },
  }
}
