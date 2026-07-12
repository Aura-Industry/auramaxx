'use client';

import React from 'react';

interface ContentAreaProps {
  children: React.ReactNode;
}

export const ContentArea: React.FC<ContentAreaProps> = ({ children }) => {
  return (
    <div className="flex-1 bg-[#f4f4f5] overflow-y-auto relative">
      {/* Subtle Grid Pattern */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#e5e5e5_1px,transparent_1px),linear-gradient(to_bottom,#e5e5e5_1px,transparent_1px)] bg-[size:3rem_3rem] opacity-30 pointer-events-none" />

      {/* Content */}
      <div className="relative z-10 p-6">
        {children}
      </div>
    </div>
  );
};
