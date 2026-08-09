import { useEffect, type ReactNode } from "react"
import {
  PRODUCT_LEGAL_EFFECTIVE_DATE,
  PRODUCT_LEGAL_EFFECTIVE_DATE_LABEL,
  PRODUCT_LEGAL_LAST_UPDATED_DATE,
  PRODUCT_LEGAL_LAST_UPDATED_DATE_LABEL,
  PRODUCT_LEGAL_VERSION,
  PRODUCT_PRIVACY_CANONICAL_URL,
  PRODUCT_PRIVACY_PATH,
  PRODUCT_TERMS_CANONICAL_URL,
  PRODUCT_TERMS_PATH,
  WEBSITE_PRIVACY_URL,
  WEBSITE_TERMS_URL,
  isOfficialProductHostname,
} from "./ProductLegalVersion"

export type ProductLegalDocumentKind = "privacy" | "terms"

export interface ProductLegalPageLayoutProps {
  children: ReactNode
  documentKind: ProductLegalDocumentKind
  scopeNotice: ReactNode
  deploymentHostname?: string
}

const linkClassName =
  "font-medium text-primary-500 underline decoration-primary-500/40 underline-offset-4 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"

function getRuntimeHostname(deploymentHostname?: string): string {
  if (deploymentHostname !== undefined) return deploymentHostname
  if (typeof window === "undefined") return ""
  return window.location.hostname
}

function upsertMetadata(
  selector: string,
  attributes: Record<string, string>
): HTMLElement | null {
  if (typeof document === "undefined") return null

  let element = document.head.querySelector<HTMLElement>(selector)
  if (!element) {
    element = document.createElement(
      selector.startsWith("link") ? "link" : "meta"
    )
    document.head.appendChild(element)
  }
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value)
  }
  return element
}

export function ProductLegalPageLayout({
  children,
  documentKind,
  scopeNotice,
  deploymentHostname,
}: ProductLegalPageLayoutProps) {
  const hostname = getRuntimeHostname(deploymentHostname)
  const officialDeployment = isOfficialProductHostname(hostname)
  const isPrivacy = documentKind === "privacy"
  const title = isPrivacy
    ? "Product Privacy Policy | Conduit"
    : "Product Terms of Service | Conduit"
  const description = isPrivacy
    ? "Privacy practices for the official Conduit Shop and Conduit Sell Product Apps."
    : "Terms governing the official Conduit Shop and Conduit Sell Product Apps."
  const canonicalUrl = isPrivacy
    ? PRODUCT_PRIVACY_CANONICAL_URL
    : PRODUCT_TERMS_CANONICAL_URL

  useEffect(() => {
    if (typeof document === "undefined") return

    if (!officialDeployment) {
      const neutralTitle = "Legal notice | Product deployment"
      const neutralDescription =
        "This deployment must provide its own privacy notice and terms."
      document.title = neutralTitle
      document.head.querySelector('link[rel="canonical"]')?.remove()
      document.head.querySelector('meta[property="og:url"]')?.remove()
      upsertMetadata('meta[name="description"]', {
        name: "description",
        content: neutralDescription,
      })
      upsertMetadata('meta[property="og:title"]', {
        property: "og:title",
        content: neutralTitle,
      })
      upsertMetadata('meta[property="og:description"]', {
        property: "og:description",
        content: neutralDescription,
      })
      upsertMetadata('meta[name="twitter:title"]', {
        name: "twitter:title",
        content: neutralTitle,
      })
      upsertMetadata('meta[name="twitter:description"]', {
        name: "twitter:description",
        content: neutralDescription,
      })
      return
    }

    document.title = title
    upsertMetadata('meta[name="description"]', {
      name: "description",
      content: description,
    })
    upsertMetadata('link[rel="canonical"]', {
      rel: "canonical",
      href: canonicalUrl,
    })
    upsertMetadata('meta[property="og:title"]', {
      property: "og:title",
      content: title,
    })
    upsertMetadata('meta[property="og:description"]', {
      property: "og:description",
      content: description,
    })
    upsertMetadata('meta[property="og:url"]', {
      property: "og:url",
      content: canonicalUrl,
    })
    upsertMetadata('meta[name="twitter:title"]', {
      name: "twitter:title",
      content: title,
    })
    upsertMetadata('meta[name="twitter:description"]', {
      name: "twitter:description",
      content: description,
    })
  }, [canonicalUrl, description, officialDeployment, title])

  if (!officialDeployment) {
    return <UnofficialHostLegalNotice hostname={hostname} />
  }

  return (
    <div className="min-h-dvh bg-[var(--background)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <a
            href="/"
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Return to the Product App"
          >
            <img
              src="/images/logo/logo-full.svg"
              alt="Conduit"
              className="h-8 w-auto"
            />
          </a>
          <span className="text-sm font-medium text-[var(--text-secondary)]">
            Product legal
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <article aria-labelledby="product-legal-title">
          <header className="border-b border-[var(--border)] pb-8">
            <p className="text-sm font-semibold text-primary-500">Legal</p>
            <h1
              id="product-legal-title"
              className="mt-2 max-w-3xl text-balance font-heading text-4xl font-semibold text-[var(--text-primary)] sm:text-5xl"
            >
              {isPrivacy
                ? "Product Privacy Policy"
                : "Product Terms of Service"}
            </h1>
            <dl className="mt-6 grid gap-3 text-sm text-[var(--text-secondary)] sm:grid-cols-3">
              <div>
                <dt className="font-semibold text-[var(--text-primary)]">
                  Effective
                </dt>
                <dd className="mt-1">
                  <time dateTime={PRODUCT_LEGAL_EFFECTIVE_DATE}>
                    {PRODUCT_LEGAL_EFFECTIVE_DATE_LABEL}
                  </time>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--text-primary)]">
                  Last updated
                </dt>
                <dd className="mt-1">
                  <time dateTime={PRODUCT_LEGAL_LAST_UPDATED_DATE}>
                    {PRODUCT_LEGAL_LAST_UPDATED_DATE_LABEL}
                  </time>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--text-primary)]">
                  Version
                </dt>
                <dd className="mt-1 break-words font-mono text-xs">
                  {PRODUCT_LEGAL_VERSION}
                </dd>
              </div>
            </dl>
          </header>

          <aside
            aria-label="Policy scope"
            className="my-8 rounded-2xl border border-primary-500/50 bg-[var(--surface-elevated)] p-5 shadow-sm"
          >
            <p className="text-pretty text-base leading-7 text-[var(--text-primary)]">
              {scopeNotice}
            </p>
            <p className="mt-4 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
              Website documents:{" "}
              <a
                href={WEBSITE_PRIVACY_URL}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer"
                className={linkClassName}
              >
                Website Privacy Policy
              </a>{" "}
              and{" "}
              <a
                href={WEBSITE_TERMS_URL}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer"
                className={linkClassName}
              >
                Website Terms of Service
              </a>
              .
            </p>
          </aside>

          <div className="space-y-9 text-pretty text-base leading-7 text-[var(--text-secondary)] [&_a]:rounded-sm [&_a]:font-medium [&_a]:text-primary-500 [&_a]:underline [&_a]:decoration-primary-500/40 [&_a]:underline-offset-4 [&_a:hover]:text-primary-600 [&_a:focus-visible]:outline-none [&_a:focus-visible]:ring-2 [&_a:focus-visible]:ring-[var(--ring)] [&_h2]:text-balance [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_li]:pl-1 [&_ol]:ml-6 [&_ol]:list-decimal [&_ol]:space-y-2 [&_p+p]:mt-4 [&_strong]:font-semibold [&_strong]:text-[var(--text-primary)] [&_ul]:ml-6 [&_ul]:list-disc [&_ul]:space-y-2">
            {children}
          </div>

          <nav
            aria-label="Product legal documents"
            className="mt-12 flex flex-wrap gap-x-5 gap-y-3 border-t border-[var(--border)] pt-6 text-sm"
          >
            {isPrivacy ? (
              <a href={PRODUCT_TERMS_PATH} className={linkClassName}>
                Read the Product Terms of Service
              </a>
            ) : (
              <a href={PRODUCT_PRIVACY_PATH} className={linkClassName}>
                Read the Product Privacy Policy
              </a>
            )}
            <a
              href="https://conduit.market/"
              referrerPolicy="no-referrer"
              rel="noopener noreferrer"
              className={linkClassName}
            >
              Visit the Conduit Website
            </a>
          </nav>
        </article>
      </main>
    </div>
  )
}

function UnofficialHostLegalNotice({ hostname }: { hostname: string }) {
  const deploymentLabel = hostname || "this host"

  return (
    <div className="min-h-dvh bg-[var(--background)] text-[var(--text-primary)]">
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl items-center px-4 py-12 sm:px-6 lg:px-8">
        <section
          aria-labelledby="independent-deployment-title"
          className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm sm:p-8"
        >
          <p className="text-sm font-semibold text-primary-500">
            Unofficial host
          </p>
          <h1
            id="independent-deployment-title"
            className="mt-2 text-balance font-heading text-3xl font-semibold"
          >
            This host needs its own legal documents
          </h1>
          <p className="mt-5 text-pretty leading-7 text-[var(--text-secondary)]">
            <span className="font-mono text-sm text-[var(--text-primary)]">
              {deploymentLabel}
            </span>{" "}
            is not one of the official Product App hosts named in the Conduit
            Product Privacy Policy and Product Terms of Service. Those documents
            do not govern this deployment. Its operator must provide privacy
            disclosures and terms appropriate to this service and must not imply
            that this is an official Conduit Product App.
          </p>
          <p className="mt-5 text-pretty leading-7 text-[var(--text-secondary)]">
            The official Product documents are available at the{" "}
            <a
              href={PRODUCT_PRIVACY_CANONICAL_URL}
              referrerPolicy="no-referrer"
              rel="noopener noreferrer"
              className={linkClassName}
            >
              Conduit Product Privacy Policy
            </a>{" "}
            and{" "}
            <a
              href={PRODUCT_TERMS_CANONICAL_URL}
              referrerPolicy="no-referrer"
              rel="noopener noreferrer"
              className={linkClassName}
            >
              Conduit Product Terms of Service
            </a>
            .
          </p>
        </section>
      </main>
    </div>
  )
}
