import { openapi } from '@/lib/openapi';
export function GET() {
  return Response.json(openapi);
}
