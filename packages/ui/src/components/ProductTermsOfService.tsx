import { ProductLegalPageLayout } from "./ProductLegalPageLayout"
import {
  ProductTermsOfServiceVersion,
  ProductTermsScopeNoticeVersion,
} from "../legal/versions/product-legal-v1.1-2026-08-09"

export function ProductTermsOfService({
  deploymentHostname,
  deploymentProfile,
}: {
  deploymentHostname?: string
  deploymentProfile?: string
} = {}) {
  return (
    <ProductLegalPageLayout
      documentKind="terms"
      deploymentHostname={deploymentHostname}
      deploymentProfile={deploymentProfile}
      scopeNotice={<ProductTermsScopeNoticeVersion />}
    >
      <ProductTermsOfServiceVersion />
    </ProductLegalPageLayout>
  )
}
