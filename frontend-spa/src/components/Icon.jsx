import {
  AddIcon, AltArrowDownIcon, AltArrowRightIcon, ArchiveIcon, ArrowLeftIcon,
  BellIcon, BusIcon, CalendarIcon, CheckCircleIcon, ClipboardListIcon,
  ClockCircleIcon, CloseIcon, CloudBoltIcon, CloudRainIcon, CloudSunIcon,
  Columns3Icon, DangerTriangleIcon, DocumentTextIcon, DownloadIcon,
  EyeClosedIcon, EyeIcon, FilterIcon, FlagIcon, FogIcon, GalleryIcon,
  GlobalIcon, HamburgerMenuIcon, InfoCircleIcon, KeyIcon, LetterIcon,
  LinkIcon, ListIcon, LogoutIcon, MagnifierIcon, MapIcon, MapPointIcon,
  MaximizeSquareIcon, MenuDotsVerticalIcon, MoonIcon, PenNewSquareIcon,
  PrinterIcon, RestartIcon, SettingsIcon, SledgehammerIcon, SunIcon,
  TicketIcon, TrashBinTrashIcon, TuningIcon, UploadIcon,
  UsersGroupRoundedIcon, Widget4Icon,
} from '@solar-icons/react/linear';
import { SettingsIcon as BoldSettingsIcon } from '@solar-icons/react/bold';

// A single semantic vocabulary keeps every VMS screen on the same icon family.
const ICONS = {
  add: AddIcon,
  alert: DangerTriangleIcon,
  archive: ArchiveIcon,
  arrowLeft: ArrowLeftIcon,
  bell: BellIcon,
  boat: BusIcon,
  calendar: CalendarIcon,
  checkCircle: CheckCircleIcon,
  chevronDown: AltArrowDownIcon,
  chevronRight: AltArrowRightIcon,
  clipboard: ClipboardListIcon,
  clock: ClockCircleIcon,
  close: CloseIcon,
  cloudFog: FogIcon,
  cloudLightning: CloudBoltIcon,
  cloudRain: CloudRainIcon,
  cloudSun: CloudSunIcon,
  columns: Columns3Icon,
  document: DocumentTextIcon,
  download: DownloadIcon,
  edit: PenNewSquareIcon,
  eye: EyeIcon,
  eyeOff: EyeClosedIcon,
  facebook: GlobalIcon,
  filter: FilterIcon,
  flag: FlagIcon,
  gear: SettingsIcon,
  grid: Widget4Icon,
  gripVertical: MenuDotsVerticalIcon,
  info: InfoCircleIcon,
  instagram: GlobalIcon,
  key: KeyIcon,
  link: LinkIcon,
  linkedin: GlobalIcon,
  list: ListIcon,
  logout: LogoutIcon,
  mail: LetterIcon,
  map: MapIcon,
  maximize: MaximizeSquareIcon,
  menu: HamburgerMenuIcon,
  moon: MoonIcon,
  photo: GalleryIcon,
  pin: MapPointIcon,
  plus: AddIcon,
  print: PrinterIcon,
  search: MagnifierIcon,
  sun: SunIcon,
  ticket: TicketIcon,
  tools: SledgehammerIcon,
  trash: TrashBinTrashIcon,
  tune: TuningIcon,
  twitterX: GlobalIcon,
  undo: RestartIcon,
  upload: UploadIcon,
  users: UsersGroupRoundedIcon,
  vehicle: BusIcon,
  wrench: SledgehammerIcon,
};

export default function Icon({ name, size = 16, strokeWidth = 1.8, className, style, filled = false }) {
  const SolarIcon = filled && name === 'gear' ? BoldSettingsIcon : ICONS[name];
  if (!SolarIcon) return null;

  return (
    <SolarIcon
      aria-hidden="true"
      className={className}
      color="currentColor"
      size={size}
      strokeWidth={strokeWidth}
      style={{ display: 'block', flexShrink: 0, ...style }}
    />
  );
}
