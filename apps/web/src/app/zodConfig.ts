import { z } from 'zod';

// Zod otherwise probes for eval with `new Function` when the first schemas are built, which the
// page's CSP blocks and reports. Imported before anything that builds a schema.
z.config({ jitless: true });
