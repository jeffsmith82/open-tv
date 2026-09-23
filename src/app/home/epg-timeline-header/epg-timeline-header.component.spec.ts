import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EpgTimelineHeaderComponent } from './epg-timeline-header.component';

describe('EpgTimelineHeaderComponent', () => {
  let component: EpgTimelineHeaderComponent;
  let fixture: ComponentFixture<EpgTimelineHeaderComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [EpgTimelineHeaderComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(EpgTimelineHeaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
