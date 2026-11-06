export function GET() {
  return Response.json(
    {
      detail:
        'This stateless URL-injection endpoint has been retired. Configure each provider once, then use /api/profiles/{id}/config_download. API documentation: /docs/api'
    },
    { status: 410 }
  );
}
export const POST = GET;
