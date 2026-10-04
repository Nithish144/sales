-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "deliveryCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryPartnerId" INTEGER;

-- CreateTable
CREATE TABLE "delivery_partners" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_partner_prices" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_partner_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_partners_name_key" ON "delivery_partners"("name");

-- CreateIndex
CREATE INDEX "delivery_partner_prices_partnerId_idx" ON "delivery_partner_prices"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_partner_prices_partnerId_quantity_key" ON "delivery_partner_prices"("partnerId", "quantity");

-- CreateIndex
CREATE INDEX "sales_deliveryPartnerId_idx" ON "sales"("deliveryPartnerId");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_partner_prices" ADD CONSTRAINT "delivery_partner_prices_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "delivery_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
