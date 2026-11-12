import { z } from 'zod';
import { PermissionPolicy } from './protocol.ts';
import type { Target } from './protocol.ts';
import { request } from './transport.ts';

// Activation checks connectivity only; it does not launch a worker or test credentials.
export async function activationConnection(target: Target) {
  try {
    const host = z.object({
      protocol: z.literal(1), adapter: z.string().min(1),
      concurrency: z.number().int().min(1).max(16), repository: z.string().min(1),
      maintenance:z.boolean().default(false),permissions:PermissionPolicy.optional(),
      capabilities:z.object({nativePermissionForwarding:z.boolean().optional()}).optional(),
      approvalRequired:z.boolean().optional(),
    }).parse(await request(target, { type: 'probe' }, 3000));
    return { state: 'connected' as const, ...host, modelAccess: 'unverified' as const };
  } catch (error) {
    return { state: 'unavailable' as const, error: (error as Error).message.slice(0, 320), modelAccess: 'unverified' as const };
  }
}

export function approvalReadiness(connection:Awaited<ReturnType<typeof activationConnection>>,userInterface:boolean){
  if(connection.state!=='connected'||!connection.permissions)return {state:'unverified',message:'Connect to the Host to check its permission interaction.'};
  if(connection.approvalRequired===false||!['ask','delegate'].includes(connection.permissions.mode))return {state:'not_required',message:'The worker native configuration does not request per-operation approvals.'};
  if(!connection.capabilities?.nativePermissionForwarding)return {state:'unavailable',message:'This Host has not advertised native permission forwarding. Update or select a compatible worker.'};
  if(!userInterface)return {state:'unavailable',message:'This client cannot show task approval controls. Open the same conversation in a client with approval UI; Rein has not switched permission modes.'};
  return {state:'available',message:'Native permission requests are reviewed inside their task in this conversation.'};
}
