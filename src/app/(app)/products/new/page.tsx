import { createProduct } from "@/app/actions/products";

export default function NewProductPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">New product</h1>
      <form action={createProduct} className="card space-y-4 max-w-xl">
        <div>
          <label className="label">Model name *</label>
          <input name="name" className="input" required placeholder="e.g. Denago City Model 1" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">SKU</label>
            <input name="sku" className="input" />
          </div>
          <div>
            <label className="label">Category</label>
            <input name="category" className="input" placeholder="e.g. eBike" />
          </div>
        </div>
        <div>
          <label className="label">Base price (R)</label>
          <input name="basePrice" className="input" inputMode="decimal" placeholder="0.00" />
        </div>
        <div>
          <label className="label">Available colours (comma-separated)</label>
          <input name="colors" className="input" placeholder="Blue, White, Black" />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea name="description" className="input" rows={3} />
        </div>
        <button className="btn-primary">Create product</button>
      </form>
    </div>
  );
}
