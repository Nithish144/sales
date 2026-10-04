const prisma = require('../prisma/client');
const { asyncHandler, badRequest, notFound, conflict } = require('../utils/errors');

const MAX_NAME = 60;

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) throw badRequest('Invalid shop ID.');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw badRequest('Invalid shop ID.');
  return id;
}

function cleanName(raw) {
  if (typeof raw !== 'string') throw badRequest('Shop name is required.');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('Shop name is required.');
  if (name.length > MAX_NAME) throw badRequest(`Shop name must be ${MAX_NAME} characters or fewer.`);
  return name;
}

const serialize = (s) => ({
  id: s.id,
  name: s.name,
  salesCount: s._count ? s._count.sales : undefined,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

async function assertNameFree(name, exceptId) {
  const existing = await prisma.shop.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (existing) throw conflict('Shop already exists.');
}

exports.parseId = parseId;

exports.list = asyncHandler(async (req, res) => {
  const shops = await prisma.shop.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { sales: true } } },
  });
  res.json(shops.map(serialize));
});

exports.create = asyncHandler(async (req, res) => {
  const name = cleanName(req.body && req.body.name);
  await assertNameFree(name);
  const shop = await prisma.shop.create({ data: { name }, include: { _count: { select: { sales: true } } } });
  res.status(201).json(serialize(shop));
});

exports.update = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const name = cleanName(req.body && req.body.name);
  const current = await prisma.shop.findUnique({ where: { id } });
  if (!current) throw notFound('Shop not found.');
  await assertNameFree(name, id);
  const shop = await prisma.shop.update({
    where: { id },
    data: { name },
    include: { _count: { select: { sales: true } } },
  });
  res.json(serialize(shop));
});

exports.remove = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const shop = await prisma.shop.findUnique({ where: { id }, include: { _count: { select: { sales: true } } } });
  if (!shop) throw notFound('Shop not found.');
  if (shop._count.sales > 0) throw conflict('This shop has existing sales and cannot be deleted.');
  await prisma.shop.delete({ where: { id } });
  res.json({ success: true });
});
