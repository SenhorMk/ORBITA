"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

import { Badge } from "@/components/ui/badge";

export interface UserItem {
  id: string;
  name: string;
  email: string;
  location: string;
  status: string;
  balance: string;
  phone?: string;
  cpf_cnpj?: string;
}

const defaultUsers: UserItem[] = [
  {
    id: "1",
    name: "Alex Thompson",
    email: "alex.t@company.com",
    location: "San Francisco, US",
    status: "Active",
    balance: "$1,250.00",
  },
  {
    id: "2",
    name: "Sarah Chen",
    email: "sarah.c@company.com",
    location: "Singapore",
    status: "Active",
    balance: "$600.00",
  },
  {
    id: "3",
    name: "James Wilson",
    email: "j.wilson@company.com",
    location: "London, UK",
    status: "Inactive",
    balance: "$650.00",
  },
  {
    id: "4",
    name: "Maria Garcia",
    email: "m.garcia@company.com",
    location: "Madrid, Spain",
    status: "Active",
    balance: "$0.00",
  },
  {
    id: "5",
    name: "David Kim",
    email: "d.kim@company.com",
    location: "Seoul, KR",
    status: "Suspended",
    balance: "-$1,000.00",
  },
];

interface TableWithDialogProps {
  users?: UserItem[];
  title?: string;
  onViewDetails?: (user: UserItem) => void;
}

export default function TableWithDialog({
  users = defaultUsers,
  title = "Base de Clientes Cadastrados",
  onViewDetails
}: TableWithDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  const toggleAll = (checked: boolean) => {
    const next: Record<string, boolean> = {};
    if (checked) {
      users.forEach((u) => { next[u.id] = true; });
    }
    setSelectedIds(next);
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isAllChecked = users.length > 0 && users.every((u) => selectedIds[u.id]);

  return (
    <div className="bg-background/80 backdrop-blur-md border border-white/10 rounded-2xl shadow-xl overflow-hidden space-y-2">
      {title && (
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">{title}</h3>
          <span className="text-xs text-slate-400 font-mono">Total: {users.length} registros</span>
        </div>
      )}
      <div className="max-h-[500px] overflow-y-auto">
        <Table>
          {/* Fixed Header */}
          <TableHeader className="sticky top-0 bg-slate-900/90 backdrop-blur-md z-10 shadow-sm border-b border-white/10">
            <TableRow className="hover:bg-transparent border-white/10">
              <TableHead className="w-[50px] text-slate-300">
                <Checkbox checked={isAllChecked} onCheckedChange={(val) => toggleAll(!!val)} />
              </TableHead>
              <TableHead className="text-slate-300 font-bold">Nome / Razão Social</TableHead>
              <TableHead className="text-slate-300 font-bold">Email</TableHead>
              <TableHead className="text-slate-300 font-bold">Localização / Endereço</TableHead>
              <TableHead className="text-slate-300 font-bold">Status</TableHead>
              <TableHead className="text-right text-slate-300 font-bold">Saldo / Valor</TableHead>
              <TableHead className="text-center text-slate-300 font-bold">Ações</TableHead>
            </TableRow>
          </TableHeader>

          {/* Scrollable Body */}
          <TableBody>
            {users.map((user) => (
              <TableRow
                key={user.id}
                className="hover:bg-white/5 border-white/10 transition-colors"
              >
                <TableCell>
                  <Checkbox
                    checked={!!selectedIds[user.id]}
                    onCheckedChange={() => toggleOne(user.id)}
                  />
                </TableCell>
                <TableCell className="font-medium text-white">{user.name}</TableCell>
                <TableCell className="text-slate-300">{user.email || "-"}</TableCell>
                <TableCell className="text-slate-300">{user.location || "-"}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      user.status === "Active" || user.status === "Ativo"
                        ? "default"
                        : user.status === "Inactive" || user.status === "Inativo"
                        ? "secondary"
                        : "destructive"
                    }
                    className={user.status === "Suspended" || user.status === "Suspenso" ? "bg-rose-500 text-white" : ""}
                  >
                    {user.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-emerald-400 font-semibold">{user.balance}</TableCell>
                <TableCell className="text-center">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (onViewDetails) {
                        onViewDetails(user);
                      }
                    }}
                    className="bg-white/5 border-white/20 text-white hover:bg-white/10"
                  >
                    Ver Detalhes
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>

          {/* Fixed Footer */}
          <TableFooter className="sticky bottom-0 bg-slate-900/90 backdrop-blur-md z-10 border-t border-white/10 shadow-inner">
            <TableRow className="hover:bg-transparent border-none">
              <TableCell colSpan={5} className="font-medium text-slate-300">
                Total de Registros: {users.length}
              </TableCell>
              <TableCell className="text-right text-emerald-400 font-bold font-mono">
                {users.length > 0 ? "OK" : "-"}
              </TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}
