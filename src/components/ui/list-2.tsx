import {
  ArrowRight,
  Award,
  Building2,
  HeartHandshake,
  Leaf,
  Lightbulb,
  Trophy,
} from "lucide-react";
import React from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export interface ListItem {
  icon: React.ReactNode;
  title: string;
  category: string;
  description: string | React.ReactNode;
  link?: string;
  action?: React.ReactNode;
  onClick?: () => void;
}

export interface List2Props {
  heading?: string;
  items?: ListItem[];
}

export const List2 = ({
  heading = "Our Achievements & Recognition",
  items = [
    {
      icon: <Trophy />,
      title: "Industry Recognition",
      category: "Achievement",
      description: "Outstanding Performance Award.",
      link: "#",
    },
    {
      icon: <Award />,
      title: "Excellence Award",
      category: "Recognition",
      description: "Best in Category Winner.",
      link: "#",
    },
    {
      icon: <Lightbulb />,
      title: "Innovation Prize",
      category: "Technology",
      description: "Breakthrough Solution of the Year.",
      link: "#",
    },
    {
      icon: <HeartHandshake />,
      title: "Customer Success",
      category: "Service",
      description: "Top-Rated Solution Provider.",
      link: "#",
    },
    {
      icon: <Building2 />,
      title: "Global Leadership",
      category: "Management",
      description: "Executive Team of the Year.",
      link: "#",
    },
    {
      icon: <Leaf />,
      title: "Sustainability Impact",
      category: "Environmental",
      description: "Green Initiative Excellence.",
      link: "#",
    },
  ],
}: List2Props) => {
  return (
    <section className="py-6">
      <div className="container mx-auto px-0">
        {heading && (
          <h1 className="mb-6 px-4 text-2xl font-semibold md:text-3xl text-white">
            {heading}
          </h1>
        )}
        <div className="flex flex-col">
          <Separator />
          {items.map((item, index) => (
            <React.Fragment key={index}>
              <div
                {...(item.onClick
                  ? {
                      role: "button" as const,
                      tabIndex: 0,
                      onClick: () => item.onClick!(),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          item.onClick!();
                        }
                      },
                    }
                  : {})}
                className={`grid items-center gap-4 px-4 py-5 md:grid-cols-4 transition-colors rounded-xl ${
                  item.onClick ? "cursor-pointer hover:bg-white/[0.04]" : ""
                }`}
              >
                <div className="order-2 flex items-center gap-3 md:order-none">
                  <span className="flex h-14 w-16 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                    {item.icon}
                  </span>
                  <div className="flex flex-col gap-1 min-w-0">
                    <h3 className="font-semibold text-white truncate">{item.title}</h3>
                    <p className="text-sm text-muted-foreground truncate">
                      {item.category}
                    </p>
                  </div>
                </div>
                <div className="order-1 text-lg font-semibold md:order-none md:col-span-2 text-slate-200">
                  {item.description}
                </div>
                {item.action ? (
                  <div className="order-3 ml-auto w-fit md:order-none">
                    {item.action}
                  </div>
                ) : item.onClick ? (
                  <Button
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      item.onClick!();
                    }}
                    className="order-3 ml-auto w-fit gap-2 md:order-none bg-white/5 border-white/20 text-white hover:bg-white/10"
                  >
                    <span>Ver detalhes</span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button variant="outline" asChild>
                    <a
                      className="order-3 ml-auto w-fit gap-2 md:order-none"
                      href={item.link || "#"}
                    >
                      <span>Ver detalhes</span>
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  </Button>
                )}
              </div>
              <Separator />
            </React.Fragment>
          ))}
        </div>
      </div>
    </section>
  );
};
