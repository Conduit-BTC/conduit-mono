import { ProductLegalPageLayout } from "./ProductLegalPageLayout"
import {
  ProductPrivacyPolicyVersion,
  ProductPrivacyScopeNoticeVersion,
} from "../legal/versions/product-legal-v1.0-2026-08-09"

export function ProductPrivacyPolicy({
  deploymentHostname,
}: {
  deploymentHostname?: string
} = {}) {
  return (
    <ProductLegalPageLayout
      documentKind="privacy"
      deploymentHostname={deploymentHostname}
      scopeNotice={<ProductPrivacyScopeNoticeVersion />}
    >
      <ProductPrivacyPolicyVersion />
    </ProductLegalPageLayout>
  )
}
