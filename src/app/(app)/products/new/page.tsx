import ProductForm from "@/components/ProductForm";

export default function NewProductPage() {
  return (
    <div className="space-y-5 max-w-xl">
      <h1 className="text-2xl font-bold">New product</h1>
      <ProductForm />
    </div>
  );
}
