import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Aviso no tom do painel: vidro sobre o preto, fio branco, sombra longa. O
 * erro é o único que ganha cor — laranja, que na identidade é recusa e
 * atenção.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:rounded-2xl group-[.toaster]:border-white/15 group-[.toaster]:bg-[#141414] group-[.toaster]:text-white group-[.toaster]:shadow-pill group-[.toaster]:font-sans group-[.toaster]:tracking-corpo",
          description: "group-[.toast]:text-[#8f8f8f]",
          actionButton: "group-[.toast]:rounded-full group-[.toast]:bg-white group-[.toast]:text-black",
          cancelButton: "group-[.toast]:rounded-full group-[.toast]:bg-white/10 group-[.toast]:text-white",
          success: "group-[.toaster]:bg-[#141414] group-[.toaster]:text-white group-[.toaster]:border-success/40",
          error:
            "group-[.toaster]:bg-[#141414] group-[.toaster]:text-white group-[.toaster]:border-destructive",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
