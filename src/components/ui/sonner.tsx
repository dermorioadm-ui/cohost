import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Aviso no tom da página: papel branco, fio, sombra da pílula. O erro é o único
 * que ganha cor de fundo — e é coral, porque na página o coral é o que pede
 * atenção.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:rounded-2xl group-[.toaster]:border-[#f0f0f0] group-[.toaster]:bg-white group-[.toaster]:text-black group-[.toaster]:shadow-pill group-[.toaster]:font-sans group-[.toaster]:tracking-corpo",
          description: "group-[.toast]:text-[#8f8f8f]",
          actionButton: "group-[.toast]:rounded-full group-[.toast]:bg-black group-[.toast]:text-white",
          cancelButton: "group-[.toast]:rounded-full group-[.toast]:bg-[#f0f0f0] group-[.toast]:text-black",
          success: "group-[.toaster]:bg-white group-[.toaster]:text-black",
          error:
            "group-[.toaster]:bg-primary group-[.toaster]:text-white group-[.toaster]:border-primary",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
