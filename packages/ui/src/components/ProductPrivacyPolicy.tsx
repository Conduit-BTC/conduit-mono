import { ProductLegalPageLayout } from "./ProductLegalPageLayout"
import {
  ProductPrivacyPolicyVersion,
  ProductPrivacyScopeNoticeVersion,
} from "../legal/versions/product-legal-v1.4-2026-09-20"

export function ProductPrivacyPolicy({
  deploymentHostname,
  deploymentProfile,
}: {
  deploymentHostname?: string
  deploymentProfile?: string
} = {}) {
  return (
    <ProductLegalPageLayout
      documentKind="privacy"
      deploymentHostname={deploymentHostname}
      deploymentProfile={deploymentProfile}
      scopeNotice={<ProductPrivacyScopeNoticeVersion />}
    >
      <ProductPrivacyPolicyVersion />
    </ProductLegalPageLayout>
  )
}
