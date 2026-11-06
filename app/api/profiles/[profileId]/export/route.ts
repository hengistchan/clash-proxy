// Deprecated alias, using the same authenticated download contract.
import { GET as download } from '../config_download/route';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = download;
