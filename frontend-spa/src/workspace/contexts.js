import { createContext } from 'react';

export const FormNoticeContext = createContext(null);
// Lets shared table cells (VehicleCell, UserAvatarName) open the right detail
// view for what was actually clicked — a vehicle cell opens the vehicle, a user
// cell opens that user — instead of the whole row always going to the vehicle.
export const RowActionsContext = createContext(null);
