'use client';

import React from 'react';

interface AppGridProps {
  children: React.ReactNode;
}

export const AppGrid: React.FC<AppGridProps> = ({ children }) => {
  return (
    <div className="grid grid-cols-12 gap-4 auto-rows-max">
      {children}
    </div>
  );
};
