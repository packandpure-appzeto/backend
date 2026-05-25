import { jest } from "@jest/globals";

function mockMongooseFind(rows = []) {
  return {
    select: () => ({
      lean: async () => rows,
    }),
    lean: async () => rows,
  };
}

jest.unstable_mockModule("../app/models/product.js", () => ({
  default: {
    find: jest.fn(() => mockMongooseFind([])),
  },
}));

jest.unstable_mockModule("../app/models/purchaseRequest.js", () => ({
  default: {
    insertMany: jest.fn(async () => []),
  },
}));

jest.unstable_mockModule("../app/models/hubInventory.js", () => ({
  default: {},
}));

describe("hubOrderOrchestrator procurement", () => {
  it("throws when shortages cannot be assigned to any vendor", async () => {
    const { createAutoPurchaseRequests } = await import(
      "../app/services/hubOrderOrchestrator.js"
    );

    const order = { _id: "order1", orderId: "ORD-1" };
    const shortages = [
      {
        productId: "507f1f77bcf86cd799439011",
        requiredQty: 2,
        availableQtyAtHub: 0,
        shortageQty: 2,
        vendorId: null,
        baseProduct: { name: "Test Product", sku: "SKU-TEST", price: 10 },
      },
    ];

    await expect(
      createAutoPurchaseRequests({ order, shortages, hubId: "MAIN_HUB" }),
    ).rejects.toThrow(/out of stock/i);
  });
});
