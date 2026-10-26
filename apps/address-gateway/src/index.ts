import approved from "../approved-names.json"
import { handleAddressGateway, type AddressGatewayEnv } from "./gateway"
export default {
  fetch(request: Request, env: AddressGatewayEnv): Promise<Response> {
    return handleAddressGateway(request, env, approved.names)
  },
}
