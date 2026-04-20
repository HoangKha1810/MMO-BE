# BE

Backend mới cho bản migration từ source PHP.

## Stack

- `Express`
- `Prisma`
- `TypeScript`
- `cookie-parser`
- `cors`

## Scripts

```bash
npm run dev
npm run build
npm run prisma:generate
```

## API đã scaffold

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/users/me`
- `GET /api/users/orders`
- `GET /api/deposits`
- `POST /api/deposits`
- `GET /api/smm/services`
- `POST /api/smm/orders`
- `GET /api/smm/orders`
- `GET /api/resources`
- `GET /api/resources/orders`
- `GET /api/resources/cart`
- `POST /api/resources/cart`
- `DELETE /api/resources/cart/:id`
- `POST /api/cards/exchange`
- `GET /api/cards/orders`
- `GET /api/forum/categories`
- `GET /api/forum/threads`
