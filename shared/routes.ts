import { z } from 'zod';
import { botLogs, farms, fields, vehicles, silos, productions, animals, jobs, alerts, weather } from './schema';

export const api = {
  bot: {
    status: {
      method: 'GET' as const,
      path: '/api/bot/status',
      responses: {
        200: z.object({
          status: z.enum(['online', 'offline', 'connecting']),
          uptime: z.number(),
          lastPing: z.string().nullable()
        })
      }
    },
    logs: {
      method: 'GET' as const,
      path: '/api/bot/logs',
      responses: {
        200: z.array(z.custom<typeof botLogs.$inferSelect>())
      }
    }
  },
  farms: {
    list: {
      method: 'GET' as const,
      path: '/api/farms',
      responses: {
        200: z.array(z.custom<typeof farms.$inferSelect>())
      }
    }
  },
  fields: {
    list: {
      method: 'GET' as const,
      path: '/api/fields',
      responses: {
        200: z.array(z.custom<typeof fields.$inferSelect>())
      }
    }
  },
  vehicles: {
    list: {
      method: 'GET' as const,
      path: '/api/vehicles',
      responses: {
        200: z.array(z.custom<typeof vehicles.$inferSelect>())
      }
    }
  },
  silos: {
    list: {
      method: 'GET' as const,
      path: '/api/silos',
      responses: {
        200: z.array(z.custom<typeof silos.$inferSelect>())
      }
    }
  },
  productions: {
    list: {
      method: 'GET' as const,
      path: '/api/productions',
      responses: {
        200: z.array(z.custom<typeof productions.$inferSelect>())
      }
    }
  },
  animals: {
    list: {
      method: 'GET' as const,
      path: '/api/animals',
      responses: {
        200: z.array(z.custom<typeof animals.$inferSelect>())
      }
    }
  },
  weather: {
    get: {
      method: 'GET' as const,
      path: '/api/weather',
      responses: {
        200: z.custom<typeof weather.$inferSelect>().nullable()
      }
    }
  },
  jobs: {
    list: {
      method: 'GET' as const,
      path: '/api/jobs',
      responses: {
        200: z.array(z.custom<typeof jobs.$inferSelect>())
      }
    }
  },
  alerts: {
    list: {
      method: 'GET' as const,
      path: '/api/alerts',
      responses: {
        200: z.array(z.custom<typeof alerts.$inferSelect>())
      }
    }
  },
  sync: {
    trigger: {
      method: 'POST' as const,
      path: '/api/sync',
      responses: {
        200: z.object({
          success: z.boolean(),
          message: z.string()
        })
      }
    }
  }
};
