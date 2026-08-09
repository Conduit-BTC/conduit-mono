import { ProductLegalPageLayout } from "./ProductLegalPageLayout"
import {
  ProductTermsOfServiceVersion,
  ProductTermsScopeNoticeVersion,
} from "../legal/versions/product-legal-v1.0-2026-08-09"

export function ProductTermsOfService({
  deploymentHostname,
}: {
  deploymentHostname?: string
} = {}) {
  return (
    <ProductLegalPageLayout
      documentKind="terms"
      deploymentHostname={deploymentHostname}
      scopeNotice={<ProductTermsScopeNoticeVersion />}
    >
      <ProductTermsOfServiceVersion />
    </ProductLegalPageLayout>
  )
}
